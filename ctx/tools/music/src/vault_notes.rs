use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub enum FmValue {
    Text(String),
    Number(i64),
    Bool(bool),
    List(Vec<String>),
}

pub struct Frontmatter {
    pub fields: Vec<(String, FmValue)>,
}

impl Frontmatter {
    fn get(&self, key: &str) -> Option<&FmValue> {
        self.fields.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn get_list(&self, key: &str) -> Vec<String> {
        match self.get(key) {
            Some(FmValue::List(items)) => items.clone(),
            _ => Vec::new(),
        }
    }

    pub fn set_list(&mut self, key: &str, items: Vec<String>) {
        if let Some(entry) = self.fields.iter_mut().find(|(k, _)| k == key) {
            entry.1 = FmValue::List(items);
        } else {
            self.fields.push((key.to_string(), FmValue::List(items)));
        }
    }

    /// Returns true if the value was newly added (i.e. something changed).
    pub fn append_list_unique(&mut self, key: &str, value: &str) -> bool {
        let mut items = self.get_list(key);
        if items.iter().any(|v| v == value) {
            return false;
        }
        items.push(value.to_string());
        self.set_list(key, items);
        true
    }

    pub fn has_tag(&self, tag: &str) -> bool {
        self.get_list("tags").iter().any(|t| t == tag)
    }

    pub fn set_if_absent_text(&mut self, key: &str, value: String) {
        if self.get(key).is_none() {
            self.fields.push((key.to_string(), FmValue::Text(value)));
        }
    }

    pub fn set_if_absent_number(&mut self, key: &str, value: i64) {
        if self.get(key).is_none() {
            self.fields.push((key.to_string(), FmValue::Number(value)));
        }
    }

    pub fn set_if_absent_bool(&mut self, key: &str, value: bool) {
        if self.get(key).is_none() {
            self.fields.push((key.to_string(), FmValue::Bool(value)));
        }
    }
}

fn unquote(s: &str) -> String {
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        s[1..s.len() - 1].replace("\\\"", "\"")
    } else {
        s.to_string()
    }
}

fn parse_scalar(s: &str) -> FmValue {
    if s == "true" {
        FmValue::Bool(true)
    } else if s == "false" {
        FmValue::Bool(false)
    } else if let Ok(n) = s.parse::<i64>() {
        FmValue::Number(n)
    } else {
        FmValue::Text(unquote(s))
    }
}

/// Parses a note's frontmatter block plus everything after it (the body,
/// preserved verbatim so hand-written prose is never touched on rewrite).
pub fn parse(text: &str) -> Result<(Frontmatter, String), String> {
    let mut lines = text.lines();
    if lines.next() != Some("---") {
        return Err("missing frontmatter delimiter".to_string());
    }

    let mut fm_lines: Vec<&str> = Vec::new();
    let mut rest_lines: Vec<&str> = Vec::new();
    let mut in_fm = true;
    for line in lines {
        if in_fm {
            if line == "---" {
                in_fm = false;
            } else {
                fm_lines.push(line);
            }
        } else {
            rest_lines.push(line);
        }
    }
    if in_fm {
        return Err("unterminated frontmatter".to_string());
    }

    let mut fields = Vec::new();
    let mut i = 0;
    while i < fm_lines.len() {
        let line = fm_lines[i];
        let Some(idx) = line.find(':') else {
            i += 1;
            continue;
        };
        let key = line[..idx].trim().to_string();
        let rest = line[idx + 1..].trim();
        if rest == "[]" {
            fields.push((key, FmValue::List(vec![])));
            i += 1;
        } else if rest.is_empty() {
            let mut items = Vec::new();
            i += 1;
            while i < fm_lines.len() && fm_lines[i].starts_with("  - ") {
                items.push(unquote(fm_lines[i][4..].trim()));
                i += 1;
            }
            fields.push((key, FmValue::List(items)));
        } else {
            fields.push((key, parse_scalar(rest)));
            i += 1;
        }
    }

    Ok((Frontmatter { fields }, rest_lines.join("\n")))
}

fn yaml_scalar(value: &str) -> String {
    let needs_quotes = value.is_empty()
        || value.starts_with(|c: char| " -?:,[]{}#&*!|>'\"%@`".contains(c))
        || value.contains(": ")
        || value.ends_with(':')
        || matches!(value.to_lowercase().as_str(), "true" | "false" | "null" | "~" | "yes" | "no")
        || value.parse::<f64>().is_ok()
        || value != value.trim();
    if needs_quotes {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        value.to_string()
    }
}

pub fn serialize(fm: &Frontmatter, body: &str) -> String {
    let mut out = String::from("---\n");
    for (key, value) in &fm.fields {
        match value {
            FmValue::List(items) => {
                if items.is_empty() {
                    out.push_str(&format!("{key}: []\n"));
                } else {
                    out.push_str(&format!("{key}:\n"));
                    for item in items {
                        if key == "tags" {
                            out.push_str(&format!("  - {item}\n"));
                        } else {
                            out.push_str(&format!("  - \"{item}\"\n"));
                        }
                    }
                }
            }
            FmValue::Number(n) => out.push_str(&format!("{key}: {n}\n")),
            FmValue::Bool(b) => out.push_str(&format!("{key}: {b}\n")),
            FmValue::Text(t) => out.push_str(&format!("{key}: {}\n", yaml_scalar(t))),
        }
    }
    out.push_str("---\n");
    out.push_str(body);
    out
}

pub enum Action {
    Created,
    Updated,
    Unchanged,
}

fn write_if_changed(path: &Path, content: &str, dry_run: bool) -> io::Result<Action> {
    let mut content = content.to_string();
    if !content.ends_with('\n') {
        content.push('\n');
    }
    let existed = path.exists();
    if existed && fs::read_to_string(path)? == content {
        return Ok(Action::Unchanged);
    }
    if !dry_run {
        fs::write(path, &content)?;
    }
    Ok(if existed { Action::Updated } else { Action::Created })
}

pub fn sanitize(name: &str) -> String {
    let replaced = name.replace('/', " -").replace(':', " -");
    let filtered: String = replaced.chars().filter(|c| !"\\*?\"<>|".contains(*c)).collect();
    filtered.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn wikilink(name: &str) -> String {
    format!("[[{}]]", sanitize(name))
}

fn format_duration(ms: i64) -> String {
    let total_secs = ms / 1000;
    format!("{}:{:02}", total_secs / 60, total_secs % 60)
}

fn timestamp() -> String {
    chrono::Local::now().format("%Y%m%d%H%M").to_string()
}

fn new_scope_frontmatter() -> Frontmatter {
    Frontmatter {
        fields: vec![
            ("tags".to_string(), FmValue::List(vec!["scope".to_string()])),
            ("Contains".to_string(), FmValue::List(vec![])),
            ("Contained By".to_string(), FmValue::List(vec![])),
        ],
    }
}

fn load_or_new_scope(path: &Path, filename: &str) -> Result<(Frontmatter, String), String> {
    if path.exists() {
        let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let (fm, body) = parse(&text)?;
        if !fm.has_tag("scope") {
            return Err(format!(
                "{filename} already exists but is not tagged `scope` — refusing to modify (likely an unrelated existing note)"
            ));
        }
        Ok((fm, body))
    } else {
        Ok((new_scope_frontmatter(), String::new()))
    }
}

pub fn ensure_music_criticism_contains(vault: &Path, genre_link: &str, dry_run: bool) -> Result<(PathBuf, Action), String> {
    let path = vault.join("Music Criticism.md");
    let text = fs::read_to_string(&path)
        .map_err(|_| "Music Criticism.md not found — run the one-time vault restructuring first".to_string())?;
    let (mut fm, body) = parse(&text)?;
    if !fm.has_tag("scope") {
        return Err("Music Criticism.md is not tagged `scope`".to_string());
    }
    fm.append_list_unique("Contains", genre_link);
    let content = serialize(&fm, &body);
    let action = write_if_changed(&path, &content, dry_run).map_err(|e| e.to_string())?;
    Ok((path, action))
}

pub fn ensure_record_collection(vault: &Path, album_link: &str, dry_run: bool) -> Result<(PathBuf, Action), String> {
    let path = vault.join("Record Collection.md");
    let text = fs::read_to_string(&path)
        .map_err(|_| "Record Collection.md not found — run the one-time vault restructuring first".to_string())?;
    let (mut fm, body) = parse(&text)?;
    if !fm.has_tag("scope") {
        return Err("Record Collection.md is not tagged `scope`".to_string());
    }
    fm.append_list_unique("Contains", album_link);
    let content = serialize(&fm, &body);
    let action = write_if_changed(&path, &content, dry_run).map_err(|e| e.to_string())?;
    Ok((path, action))
}

pub fn ensure_genre_scope(vault: &Path, genre: &str, band_link: &str, dry_run: bool) -> Result<(PathBuf, Action), String> {
    let filename = format!("{}.md", sanitize(genre));
    let path = vault.join(&filename);
    let (mut fm, body) = load_or_new_scope(&path, &filename)?;
    fm.append_list_unique("Contains", band_link);
    if fm.get_list("Contained By").is_empty() {
        fm.set_list("Contained By", vec!["[[Music Criticism]]".to_string()]);
    }
    let content = serialize(&fm, &body);
    let action = write_if_changed(&path, &content, dry_run).map_err(|e| e.to_string())?;
    Ok((path, action))
}

pub fn ensure_band_scope(
    vault: &Path,
    band: &str,
    album_link: &str,
    genre_link: Option<&str>,
    dry_run: bool,
) -> Result<(PathBuf, Action), String> {
    let filename = format!("{}.md", sanitize(band));
    let path = vault.join(&filename);
    let (mut fm, body) = load_or_new_scope(&path, &filename)?;
    fm.append_list_unique("Contains", album_link);
    if let Some(g) = genre_link {
        fm.append_list_unique("Contained By", g);
    }
    let content = serialize(&fm, &body);
    let action = write_if_changed(&path, &content, dry_run).map_err(|e| e.to_string())?;
    Ok((path, action))
}

pub struct AlbumMeta {
    pub year: Option<i64>,
    pub genre: Option<String>,
    pub loved: Option<bool>,
    pub rating: Option<i64>,
}

fn default_album_body(band: &str, album: &str) -> String {
    format!(
        "\n{}\nStatus: #MOC\nTags: [[{band}]]\n# {album}\n\n\n# Connections\n\n```dataview\nLIST FROM [[]]\n\n```\n",
        timestamp()
    )
}

pub fn ensure_album_scope(
    vault: &Path,
    band: &str,
    album: &str,
    band_link: &str,
    song_links: &[String],
    meta: &AlbumMeta,
    owned: bool,
    dry_run: bool,
) -> Result<(PathBuf, Action), String> {
    let filename = format!("{}.md", sanitize(&format!("{band} - {album}")));
    let path = vault.join(&filename);
    let (mut fm, body) = if path.exists() {
        let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let (fm, body) = parse(&text)?;
        if !fm.has_tag("scope") {
            return Err(format!("{filename} already exists but is not tagged `scope` — refusing to modify"));
        }
        (fm, body)
    } else {
        (new_scope_frontmatter(), default_album_body(band, album))
    };

    for link in song_links {
        fm.append_list_unique("Contains", link);
    }
    fm.append_list_unique("Contained By", band_link);
    if owned {
        fm.append_list_unique("Contained By", "[[Record Collection]]");
    }
    if let Some(y) = meta.year {
        fm.set_if_absent_number("year", y);
    }
    if let Some(g) = &meta.genre {
        fm.set_if_absent_text("genre", g.clone());
    }
    if let Some(l) = meta.loved {
        fm.set_if_absent_bool("loved", l);
    }
    if let Some(r) = meta.rating {
        fm.set_if_absent_number("rating", r);
    }

    let content = serialize(&fm, &body);
    let action = write_if_changed(&path, &content, dry_run).map_err(|e| e.to_string())?;
    Ok((path, action))
}

pub struct SongMeta {
    pub track_number: Option<i64>,
    pub duration_ms: Option<i64>,
    pub rating: Option<i64>,
    pub loved: Option<bool>,
}

/// Song memos are create-only: once written, later runs never touch them
/// again, so any thoughts added by hand are permanently safe.
pub fn ensure_song_memo(
    vault: &Path,
    band: &str,
    album: &str,
    song: &str,
    meta: &SongMeta,
    dry_run: bool,
) -> Result<(PathBuf, Action), String> {
    let filename = format!("{}.md", sanitize(&format!("{band} - {album} - {song}")));
    let path = vault.join(&filename);
    if path.exists() {
        let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let (fm, _) = parse(&text)?;
        if !fm.has_tag("memo") {
            return Err(format!("{filename} already exists but is not tagged `memo` — refusing to touch"));
        }
        return Ok((path, Action::Unchanged));
    }

    let mut fm = Frontmatter {
        fields: vec![
            ("tags".to_string(), FmValue::List(vec!["memo".to_string()])),
            ("topic".to_string(), FmValue::Text(song.to_string())),
        ],
    };
    if let Some(t) = meta.track_number {
        fm.fields.push(("track".to_string(), FmValue::Number(t)));
    }
    if let Some(d) = meta.duration_ms {
        fm.fields.push(("duration".to_string(), FmValue::Text(format_duration(d))));
    }
    if let Some(r) = meta.rating {
        fm.fields.push(("rating".to_string(), FmValue::Number(r)));
    }
    if let Some(l) = meta.loved {
        fm.fields.push(("loved".to_string(), FmValue::Bool(l)));
    }

    let album_link = wikilink(&format!("{band} - {album}"));
    let body = format!(
        "\n{}\nTags: {album_link}\n# {song}\n\n\n# References\n\n```dataview\nLIST FROM [[]]\n\n```\n",
        timestamp()
    );
    let content = serialize(&fm, &body);
    let action = write_if_changed(&path, &content, dry_run).map_err(|e| e.to_string())?;
    Ok((path, action))
}
