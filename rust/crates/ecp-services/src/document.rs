//! Document service — in-memory text buffer management with cursor tracking and undo/redo.

use std::collections::HashMap;

use ecp_protocol::{ECPError, HandlerResult};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::Service;

// ─────────────────────────────────────────────────────────────────────────────
// Core types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub line: usize,
    pub column: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cursor {
    pub position: Position,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<Position>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<Position>,
}

/// A single edit operation for undo/redo.
#[derive(Debug, Clone)]
struct EditOperation {
    kind: EditKind,
    position: Position,
    text: String,
}

#[derive(Debug, Clone, Copy)]
enum EditKind {
    Insert,
    Delete,
}

/// An undo action that groups related operations.
#[derive(Debug, Clone)]
struct UndoAction {
    operations: Vec<EditOperation>,
    cursors_before: Vec<Cursor>,
    cursors_after: Vec<Cursor>,
}

/// An in-memory document with text buffer, cursors, and undo history.
struct Document {
    id: String,
    uri: String,
    language_id: String,
    content: String,
    lines: Vec<String>,
    version: u64,
    cursors: Vec<Cursor>,
    undo_stack: Vec<UndoAction>,
    redo_stack: Vec<UndoAction>,
    is_dirty: bool,
    read_only: bool,
}

impl Document {
    fn new(id: String, uri: String, content: String, language_id: String) -> Self {
        let lines = content.lines().map(|l| l.to_string()).collect::<Vec<_>>();
        Self {
            id,
            uri,
            language_id,
            lines,
            content,
            version: 1,
            cursors: vec![Cursor {
                position: Position { line: 0, column: 0 },
                anchor: None,
                head: None,
            }],
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            is_dirty: false,
            read_only: false,
        }
    }

    fn line_count(&self) -> usize {
        self.lines.len().max(1)
    }

    fn get_content(&self) -> &str {
        &self.content
    }

    fn get_line(&self, line: usize) -> Option<&str> {
        self.lines.get(line).map(|s| s.as_str())
    }

    fn rebuild_content(&mut self) {
        self.content = self.lines.join("\n");
        self.version += 1;
    }

    fn insert_text(&mut self, pos: &Position, text: &str) {
        // Save undo
        let cursors_before = self.cursors.clone();
        let op = EditOperation {
            kind: EditKind::Insert,
            position: pos.clone(),
            text: text.to_string(),
        };

        // Perform insert
        let new_lines: Vec<&str> = text.split('\n').collect();

        if pos.line >= self.lines.len() {
            // Extend lines
            while self.lines.len() <= pos.line {
                self.lines.push(String::new());
            }
        }

        if new_lines.len() == 1 {
            // Single-line insert
            if let Some(line) = self.lines.get_mut(pos.line) {
                let col = pos.column.min(line.len());
                line.insert_str(col, text);
            }
        } else {
            // Multi-line insert
            let current_line = self.lines.get(pos.line).cloned().unwrap_or_default();
            let col = pos.column.min(current_line.len());
            let before = &current_line[..col];
            let after = &current_line[col..];

            let first = format!("{}{}", before, new_lines[0]);
            let last = format!("{}{}", new_lines[new_lines.len() - 1], after);

            // Remove original line and insert new lines
            self.lines.remove(pos.line);
            let mut insert_pos = pos.line;
            self.lines.insert(insert_pos, first);
            insert_pos += 1;
            for mid in &new_lines[1..new_lines.len() - 1] {
                self.lines.insert(insert_pos, mid.to_string());
                insert_pos += 1;
            }
            self.lines.insert(insert_pos, last);
        }

        self.rebuild_content();
        self.is_dirty = true;
        self.redo_stack.clear();

        let cursors_after = self.cursors.clone();
        self.undo_stack.push(UndoAction {
            operations: vec![op],
            cursors_before,
            cursors_after,
        });
    }

    fn delete_range(&mut self, range: &Range) {
        let cursors_before = self.cursors.clone();

        // Capture deleted text for undo
        let deleted = self.get_text_in_range(range);
        let op = EditOperation {
            kind: EditKind::Delete,
            position: range.start.clone(),
            text: deleted,
        };

        let start_line = range.start.line.min(self.lines.len().saturating_sub(1));
        let end_line = range.end.line.min(self.lines.len().saturating_sub(1));

        if start_line == end_line {
            if let Some(line) = self.lines.get_mut(start_line) {
                let start_col = range.start.column.min(line.len());
                let end_col = range.end.column.min(line.len());
                line.drain(start_col..end_col);
            }
        } else {
            let before = self.lines.get(start_line)
                .map(|l| l[..range.start.column.min(l.len())].to_string())
                .unwrap_or_default();
            let after = self.lines.get(end_line)
                .map(|l| l[range.end.column.min(l.len())..].to_string())
                .unwrap_or_default();

            // Remove lines between start and end (inclusive)
            let remove_count = end_line - start_line + 1;
            self.lines.drain(start_line..start_line + remove_count);
            self.lines.insert(start_line, format!("{}{}", before, after));
        }

        self.rebuild_content();
        self.is_dirty = true;
        self.redo_stack.clear();

        let cursors_after = self.cursors.clone();
        self.undo_stack.push(UndoAction {
            operations: vec![op],
            cursors_before,
            cursors_after,
        });
    }

    fn get_text_in_range(&self, range: &Range) -> String {
        let start_line = range.start.line.min(self.lines.len().saturating_sub(1));
        let end_line = range.end.line.min(self.lines.len().saturating_sub(1));

        if start_line == end_line {
            let line = self.lines.get(start_line).map(|s| s.as_str()).unwrap_or("");
            let s = range.start.column.min(line.len());
            let e = range.end.column.min(line.len());
            line[s..e].to_string()
        } else {
            let mut result = String::new();
            for i in start_line..=end_line {
                let line = self.lines.get(i).map(|s| s.as_str()).unwrap_or("");
                if i == start_line {
                    result.push_str(&line[range.start.column.min(line.len())..]);
                } else if i == end_line {
                    result.push_str(&line[..range.end.column.min(line.len())]);
                } else {
                    result.push_str(line);
                }
                if i < end_line {
                    result.push('\n');
                }
            }
            result
        }
    }

    fn undo(&mut self) -> Option<Vec<Cursor>> {
        let action = self.undo_stack.pop()?;
        // Reverse each operation
        for op in action.operations.iter().rev() {
            match op.kind {
                EditKind::Insert => {
                    // Undo insert = delete the inserted text
                    let end = calculate_end_position(&op.position, &op.text);
                    self.silent_delete(&Range { start: op.position.clone(), end });
                }
                EditKind::Delete => {
                    // Undo delete = re-insert the deleted text
                    self.silent_insert(&op.position, &op.text);
                }
            }
        }
        self.cursors = action.cursors_before.clone();
        self.redo_stack.push(action);
        self.rebuild_content();
        Some(self.cursors.clone())
    }

    fn redo(&mut self) -> Option<Vec<Cursor>> {
        let action = self.redo_stack.pop()?;
        for op in &action.operations {
            match op.kind {
                EditKind::Insert => {
                    self.silent_insert(&op.position, &op.text);
                }
                EditKind::Delete => {
                    let end = calculate_end_position(&op.position, &op.text);
                    self.silent_delete(&Range { start: op.position.clone(), end });
                }
            }
        }
        self.cursors = action.cursors_after.clone();
        self.undo_stack.push(action);
        self.rebuild_content();
        Some(self.cursors.clone())
    }

    /// Insert without creating undo entries (for undo/redo replay).
    fn silent_insert(&mut self, pos: &Position, text: &str) {
        let new_lines: Vec<&str> = text.split('\n').collect();
        while self.lines.len() <= pos.line {
            self.lines.push(String::new());
        }
        if new_lines.len() == 1 {
            if let Some(line) = self.lines.get_mut(pos.line) {
                let col = pos.column.min(line.len());
                line.insert_str(col, text);
            }
        } else {
            let current = self.lines.get(pos.line).cloned().unwrap_or_default();
            let col = pos.column.min(current.len());
            let first = format!("{}{}", &current[..col], new_lines[0]);
            let last = format!("{}{}", new_lines[new_lines.len() - 1], &current[col..]);
            self.lines.remove(pos.line);
            let mut i = pos.line;
            self.lines.insert(i, first);
            i += 1;
            for mid in &new_lines[1..new_lines.len() - 1] {
                self.lines.insert(i, mid.to_string());
                i += 1;
            }
            self.lines.insert(i, last);
        }
    }

    fn silent_delete(&mut self, range: &Range) {
        let sl = range.start.line.min(self.lines.len().saturating_sub(1));
        let el = range.end.line.min(self.lines.len().saturating_sub(1));
        if sl == el {
            if let Some(line) = self.lines.get_mut(sl) {
                let s = range.start.column.min(line.len());
                let e = range.end.column.min(line.len());
                line.drain(s..e);
            }
        } else {
            let before = self.lines.get(sl)
                .map(|l| l[..range.start.column.min(l.len())].to_string())
                .unwrap_or_default();
            let after = self.lines.get(el)
                .map(|l| l[range.end.column.min(l.len())..].to_string())
                .unwrap_or_default();
            self.lines.drain(sl..=el);
            self.lines.insert(sl, format!("{}{}", before, after));
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Document service
// ─────────────────────────────────────────────────────────────────────────────

pub struct DocumentService {
    documents: RwLock<HashMap<String, Document>>,
    uri_to_id: RwLock<HashMap<String, String>>,
}

impl DocumentService {
    pub fn new() -> Self {
        Self {
            documents: RwLock::new(HashMap::new()),
            uri_to_id: RwLock::new(HashMap::new()),
        }
    }
}

impl Service for DocumentService {
    fn namespace(&self) -> &str {
        "document"
    }

    async fn handle(&self, method: &str, params: Option<serde_json::Value>) -> HandlerResult {
        match method {
            "document/open" => {
                let p: DocOpenParams = parse_params(params)?;
                let uri = p.uri.clone();
                let content = if uri.starts_with("file://") {
                    let path = uri.strip_prefix("file://").unwrap_or(&uri);
                    tokio::fs::read_to_string(path).await
                        .unwrap_or_else(|_| p.content.unwrap_or_default())
                } else {
                    p.content.unwrap_or_default()
                };
                let lang = p.language_id.unwrap_or_else(|| detect_language(&uri));
                let id = format!("doc-{}-{}", now_ms(), rand_hex(4));

                let doc = Document::new(id.clone(), uri.clone(), content, lang.clone());
                let line_count = doc.line_count();
                let version = doc.version;

                self.documents.write().insert(id.clone(), doc);
                self.uri_to_id.write().insert(uri.clone(), id.clone());

                Ok(json!({
                    "documentId": id,
                    "info": {
                        "documentId": id,
                        "uri": uri,
                        "languageId": lang,
                        "lineCount": line_count,
                        "version": version,
                        "isDirty": false,
                        "isReadOnly": false,
                    }
                }))
            }

            "document/close" => {
                let p: DocIdParam = parse_params(params)?;
                let removed = self.documents.write().remove(&p.document_id);
                if let Some(doc) = &removed {
                    self.uri_to_id.write().remove(&doc.uri);
                }
                Ok(json!({ "success": removed.is_some() }))
            }

            "document/info" => {
                let p: DocIdParam = parse_params(params)?;
                let docs = self.documents.read();
                let doc = docs.get(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                Ok(json!({
                    "documentId": doc.id,
                    "uri": doc.uri,
                    "languageId": doc.language_id,
                    "lineCount": doc.line_count(),
                    "version": doc.version,
                    "isDirty": doc.is_dirty,
                    "isReadOnly": doc.read_only,
                }))
            }

            "document/list" => {
                let docs = self.documents.read();
                let list: Vec<serde_json::Value> = docs.values().map(|d| {
                    json!({
                        "documentId": d.id,
                        "uri": d.uri,
                        "languageId": d.language_id,
                        "lineCount": d.line_count(),
                        "version": d.version,
                        "isDirty": d.is_dirty,
                    })
                }).collect();
                Ok(json!({ "documents": list }))
            }

            "document/content" => {
                let p: DocIdParam = parse_params(params)?;
                let docs = self.documents.read();
                let doc = docs.get(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                Ok(json!({
                    "content": doc.get_content(),
                    "lineCount": doc.line_count(),
                    "version": doc.version,
                }))
            }

            "document/line" => {
                let p: DocLineParam = parse_params(params)?;
                let docs = self.documents.read();
                let doc = docs.get(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                let text = doc.get_line(p.line)
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                Ok(json!({ "lineNumber": p.line, "text": text }))
            }

            "document/version" => {
                let p: DocIdParam = parse_params(params)?;
                let docs = self.documents.read();
                let doc = docs.get(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                Ok(json!({ "version": doc.version }))
            }

            "document/insert" => {
                let p: DocInsertParams = parse_params(params)?;
                let mut docs = self.documents.write();
                let doc = docs.get_mut(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                doc.insert_text(&p.position, &p.text);
                Ok(json!({ "success": true, "version": doc.version }))
            }

            "document/delete" => {
                let p: DocDeleteParams = parse_params(params)?;
                let mut docs = self.documents.write();
                let doc = docs.get_mut(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                doc.delete_range(&p.range);
                Ok(json!({ "success": true, "version": doc.version }))
            }

            "document/replace" => {
                let p: DocReplaceParams = parse_params(params)?;
                let mut docs = self.documents.write();
                let doc = docs.get_mut(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                doc.delete_range(&p.range);
                doc.insert_text(&p.range.start, &p.text);
                Ok(json!({ "success": true, "version": doc.version }))
            }

            "document/setContent" => {
                let p: DocSetContentParams = parse_params(params)?;
                let mut docs = self.documents.write();
                let doc = docs.get_mut(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                doc.lines = p.content.lines().map(|l| l.to_string()).collect();
                doc.rebuild_content();
                doc.is_dirty = true;
                doc.undo_stack.clear();
                doc.redo_stack.clear();
                Ok(json!({ "success": true, "version": doc.version }))
            }

            "document/cursors" => {
                let p: DocIdParam = parse_params(params)?;
                let docs = self.documents.read();
                let doc = docs.get(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                Ok(json!({ "cursors": doc.cursors }))
            }

            "document/setCursors" => {
                let p: DocSetCursorsParams = parse_params(params)?;
                let mut docs = self.documents.write();
                let doc = docs.get_mut(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                doc.cursors = p.cursors;
                Ok(json!({ "success": true }))
            }

            "document/undo" => {
                let p: DocIdParam = parse_params(params)?;
                let mut docs = self.documents.write();
                let doc = docs.get_mut(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                let cursors = doc.undo();
                Ok(json!({
                    "success": cursors.is_some(),
                    "version": doc.version,
                    "canUndo": !doc.undo_stack.is_empty(),
                    "canRedo": !doc.redo_stack.is_empty(),
                }))
            }

            "document/redo" => {
                let p: DocIdParam = parse_params(params)?;
                let mut docs = self.documents.write();
                let doc = docs.get_mut(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                let cursors = doc.redo();
                Ok(json!({
                    "success": cursors.is_some(),
                    "version": doc.version,
                    "canUndo": !doc.undo_stack.is_empty(),
                    "canRedo": !doc.redo_stack.is_empty(),
                }))
            }

            "document/canUndo" => {
                let p: DocIdParam = parse_params(params)?;
                let docs = self.documents.read();
                let doc = docs.get(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                Ok(json!({ "canUndo": !doc.undo_stack.is_empty() }))
            }

            "document/canRedo" => {
                let p: DocIdParam = parse_params(params)?;
                let docs = self.documents.read();
                let doc = docs.get(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                Ok(json!({ "canRedo": !doc.redo_stack.is_empty() }))
            }

            "document/isDirty" => {
                let p: DocIdParam = parse_params(params)?;
                let docs = self.documents.read();
                let doc = docs.get(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                Ok(json!({ "isDirty": doc.is_dirty }))
            }

            "document/markClean" => {
                let p: DocIdParam = parse_params(params)?;
                let mut docs = self.documents.write();
                let doc = docs.get_mut(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                doc.is_dirty = false;
                Ok(json!({ "success": true }))
            }

            "document/lines" => {
                let p: DocLinesParam = parse_params(params)?;
                let docs = self.documents.read();
                let doc = docs.get(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                let start = p.start_line.min(doc.lines.len());
                let end = p.end_line.min(doc.lines.len());
                let lines: Vec<serde_json::Value> = (start..end)
                    .map(|i| json!({ "lineNumber": i, "text": doc.lines.get(i).unwrap_or(&String::new()) }))
                    .collect();
                Ok(json!({ "lines": lines }))
            }

            "document/textInRange" => {
                let p: DocTextInRangeParam = parse_params(params)?;
                let docs = self.documents.read();
                let doc = docs.get(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                let text = doc.get_text_in_range(&p.range);
                Ok(json!({ "text": text }))
            }

            "document/setCursor" => {
                let p: DocSetCursorParam = parse_params(params)?;
                let mut docs = self.documents.write();
                let doc = docs.get_mut(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                doc.cursors = vec![Cursor {
                    position: p.position,
                    anchor: p.selection.as_ref().map(|s| s.anchor.clone()),
                    head: p.selection.as_ref().map(|s| s.active.clone()),
                }];
                Ok(json!({ "success": true }))
            }

            "document/addCursor" => {
                let p: DocAddCursorParam = parse_params(params)?;
                let mut docs = self.documents.write();
                let doc = docs.get_mut(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                doc.cursors.push(Cursor {
                    position: p.position,
                    anchor: None,
                    head: None,
                });
                Ok(json!({ "success": true }))
            }

            "document/moveCursors" => {
                let p: DocMoveCursorsParam = parse_params(params)?;
                let mut docs = self.documents.write();
                let doc = docs.get_mut(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                for cursor in &mut doc.cursors {
                    match p.direction.as_str() {
                        "up" => cursor.position.line = cursor.position.line.saturating_sub(1),
                        "down" => cursor.position.line = (cursor.position.line + 1).min(doc.lines.len().saturating_sub(1)),
                        "left" => cursor.position.column = cursor.position.column.saturating_sub(1),
                        "right" => {
                            let max_col = doc.lines.get(cursor.position.line).map(|l| l.len()).unwrap_or(0);
                            cursor.position.column = (cursor.position.column + 1).min(max_col);
                        }
                        _ => {}
                    }
                }
                Ok(json!({ "success": true }))
            }

            "document/selectAll" => {
                let p: DocIdParam = parse_params(params)?;
                let mut docs = self.documents.write();
                let doc = docs.get_mut(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                let last_line = doc.lines.len().saturating_sub(1);
                let last_col = doc.lines.last().map(|l| l.len()).unwrap_or(0);
                doc.cursors = vec![Cursor {
                    position: Position { line: last_line, column: last_col },
                    anchor: Some(Position { line: 0, column: 0 }),
                    head: Some(Position { line: last_line, column: last_col }),
                }];
                Ok(json!({ "success": true }))
            }

            "document/clearSelections" => {
                let p: DocIdParam = parse_params(params)?;
                let mut docs = self.documents.write();
                let doc = docs.get_mut(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                for cursor in &mut doc.cursors {
                    cursor.anchor = None;
                    cursor.head = None;
                }
                Ok(json!({ "success": true }))
            }

            "document/selections" => {
                let p: DocIdParam = parse_params(params)?;
                let docs = self.documents.read();
                let doc = docs.get(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                let selections: Vec<String> = doc.cursors.iter()
                    .filter(|c| c.anchor.is_some() && c.head.is_some())
                    .filter_map(|c| {
                        let range = Range {
                            start: c.anchor.clone().unwrap(),
                            end: c.head.clone().unwrap(),
                        };
                        Some(doc.get_text_in_range(&range))
                    })
                    .collect();
                Ok(json!({ "selections": selections }))
            }

            "document/positionToOffset" => {
                let p: DocPositionParam = parse_params(params)?;
                let docs = self.documents.read();
                let doc = docs.get(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                let mut offset = 0usize;
                for (i, line) in doc.lines.iter().enumerate() {
                    if i == p.position.line {
                        offset += p.position.column.min(line.len());
                        break;
                    }
                    offset += line.len() + 1; // +1 for newline
                }
                Ok(json!({ "offset": offset }))
            }

            "document/offsetToPosition" => {
                let p: DocOffsetParam = parse_params(params)?;
                let docs = self.documents.read();
                let doc = docs.get(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                let mut remaining = p.offset;
                let mut line = 0usize;
                for (i, l) in doc.lines.iter().enumerate() {
                    let line_len = l.len() + 1; // +1 for newline
                    if remaining < line_len {
                        line = i;
                        break;
                    }
                    remaining -= line_len;
                    line = i + 1;
                }
                Ok(json!({ "position": { "line": line, "column": remaining } }))
            }

            "document/wordAtPosition" => {
                let p: DocPositionParam = parse_params(params)?;
                let docs = self.documents.read();
                let doc = docs.get(&p.document_id)
                    .ok_or_else(|| doc_not_found(&p.document_id))?;
                if let Some(line_text) = doc.lines.get(p.position.line) {
                    let col = p.position.column.min(line_text.len());
                    let chars: Vec<char> = line_text.chars().collect();
                    if col < chars.len() && (chars[col].is_alphanumeric() || chars[col] == '_') {
                        let mut start = col;
                        while start > 0 && (chars[start - 1].is_alphanumeric() || chars[start - 1] == '_') {
                            start -= 1;
                        }
                        let mut end = col;
                        while end < chars.len() && (chars[end].is_alphanumeric() || chars[end] == '_') {
                            end += 1;
                        }
                        let word: String = chars[start..end].iter().collect();
                        Ok(json!({
                            "text": word,
                            "range": {
                                "start": { "line": p.position.line, "column": start },
                                "end": { "line": p.position.line, "column": end },
                            }
                        }))
                    } else {
                        Ok(Value::Null)
                    }
                } else {
                    Ok(Value::Null)
                }
            }

            _ => Err(ECPError::method_not_found(method)),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct DocOpenParams {
    uri: String,
    content: Option<String>,
    #[serde(rename = "languageId")]
    language_id: Option<String>,
}

#[derive(Deserialize)]
struct DocIdParam {
    #[serde(rename = "documentId")]
    document_id: String,
}

#[derive(Deserialize)]
struct DocLineParam {
    #[serde(rename = "documentId")]
    document_id: String,
    line: usize,
}

#[derive(Deserialize)]
struct DocInsertParams {
    #[serde(rename = "documentId")]
    document_id: String,
    position: Position,
    text: String,
}

#[derive(Deserialize)]
struct DocDeleteParams {
    #[serde(rename = "documentId")]
    document_id: String,
    range: Range,
}

#[derive(Deserialize)]
struct DocReplaceParams {
    #[serde(rename = "documentId")]
    document_id: String,
    range: Range,
    text: String,
}

#[derive(Deserialize)]
struct DocSetContentParams {
    #[serde(rename = "documentId")]
    document_id: String,
    content: String,
}

#[derive(Deserialize)]
struct DocSetCursorsParams {
    #[serde(rename = "documentId")]
    document_id: String,
    cursors: Vec<Cursor>,
}

#[derive(Deserialize)]
struct DocLinesParam {
    #[serde(rename = "documentId")]
    document_id: String,
    #[serde(rename = "startLine")]
    start_line: usize,
    #[serde(rename = "endLine")]
    end_line: usize,
}

#[derive(Deserialize)]
struct DocTextInRangeParam {
    #[serde(rename = "documentId")]
    document_id: String,
    range: Range,
}

#[derive(Deserialize, Clone)]
struct SelectionParam {
    anchor: Position,
    active: Position,
}

#[derive(Deserialize)]
struct DocSetCursorParam {
    #[serde(rename = "documentId")]
    document_id: String,
    position: Position,
    selection: Option<SelectionParam>,
}

#[derive(Deserialize)]
struct DocAddCursorParam {
    #[serde(rename = "documentId")]
    document_id: String,
    position: Position,
}

#[derive(Deserialize)]
struct DocMoveCursorsParam {
    #[serde(rename = "documentId")]
    document_id: String,
    direction: String,
}

#[derive(Deserialize)]
struct DocPositionParam {
    #[serde(rename = "documentId")]
    document_id: String,
    position: Position,
}

#[derive(Deserialize)]
struct DocOffsetParam {
    #[serde(rename = "documentId")]
    document_id: String,
    offset: usize,
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

fn parse_params<T: for<'de> Deserialize<'de>>(params: Option<serde_json::Value>) -> Result<T, ECPError> {
    match params {
        Some(v) => serde_json::from_value(v)
            .map_err(|e| ECPError::invalid_params(format!("Invalid parameters: {e}"))),
        None => Err(ECPError::invalid_params("Parameters required")),
    }
}

fn doc_not_found(id: &str) -> ECPError {
    ECPError::server_error(format!("Document not found: {id}"))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn rand_hex(bytes: usize) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes * 2);
    for _ in 0..bytes {
        let _ = write!(s, "{:02x}", rand::random::<u8>());
    }
    s
}

fn detect_language(uri: &str) -> String {
    let ext = uri.rsplit('.').next().unwrap_or("");
    match ext {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" => "javascript",
        "py" => "python",
        "rb" => "ruby",
        "go" => "go",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" => "cpp",
        "swift" => "swift",
        "kt" | "kts" => "kotlin",
        "md" => "markdown",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "html" | "htm" => "html",
        "css" => "css",
        "sql" => "sql",
        "sh" | "bash" | "zsh" => "shellscript",
        _ => "plaintext",
    }.to_string()
}

fn calculate_end_position(start: &Position, text: &str) -> Position {
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.len() == 1 {
        Position {
            line: start.line,
            column: start.column + text.len(),
        }
    } else {
        Position {
            line: start.line + lines.len() - 1,
            column: lines.last().map(|l| l.len()).unwrap_or(0),
        }
    }
}
