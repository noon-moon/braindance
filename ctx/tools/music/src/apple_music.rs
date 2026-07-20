use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Deserialize, Default, Clone)]
pub struct Track {
    #[serde(rename = "Name")]
    pub name: Option<String>,
    #[serde(rename = "Artist")]
    pub artist: Option<String>,
    #[serde(rename = "Album Artist")]
    pub album_artist: Option<String>,
    #[serde(rename = "Album")]
    pub album: Option<String>,
    #[serde(rename = "Genre")]
    pub genre: Option<String>,
    #[serde(rename = "Year")]
    pub year: Option<i64>,
    #[serde(rename = "Track Number")]
    pub track_number: Option<i64>,
    #[serde(rename = "Disc Number")]
    pub disc_number: Option<i64>,
    #[serde(rename = "Total Time")]
    pub total_time_ms: Option<i64>,
    #[serde(rename = "Play Count")]
    pub play_count: Option<i64>,
    #[serde(rename = "Rating")]
    pub rating: Option<i64>,
    #[serde(rename = "Album Rating")]
    pub album_rating: Option<i64>,
    #[serde(rename = "Loved")]
    pub loved: Option<bool>,
    #[serde(rename = "Album Loved")]
    pub album_loved: Option<bool>,
    #[serde(rename = "Compilation")]
    pub compilation: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct Library {
    #[serde(rename = "Tracks")]
    pub tracks: HashMap<String, Track>,
}

pub struct MatchedAlbum {
    pub band: String,
    pub album: String,
    pub tracks: Vec<Track>,
    pub year: Option<i64>,
    pub genre: Option<String>,
    pub loved: Option<bool>,
    pub rating: Option<i64>,
}

pub fn load_library(path: &Path) -> Result<Library, String> {
    plist::from_file(path).map_err(|e| format!("Failed to parse {}: {e}", path.display()))
}

fn normalize(s: &str) -> String {
    s.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Picks the most frequent value; ties broken by whichever appeared first.
fn mode_str<'a>(values: impl Iterator<Item = &'a str>) -> Option<&'a str> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    let mut first_seen: HashMap<&str, usize> = HashMap::new();
    for (i, v) in values.enumerate() {
        *counts.entry(v).or_insert(0) += 1;
        first_seen.entry(v).or_insert(i);
    }
    counts
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| first_seen[b.0].cmp(&first_seen[a.0])))
        .map(|(k, _)| k)
}

/// Picks the most frequent year; ties broken by the smaller (earlier) year.
fn mode_year(tracks: &[&Track]) -> Option<i64> {
    let mut counts: HashMap<i64, usize> = HashMap::new();
    for t in tracks {
        if let Some(y) = t.year {
            *counts.entry(y).or_insert(0) += 1;
        }
    }
    counts
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(&a.0)))
        .map(|(y, _)| y)
}

fn derive_band(tracks: &[&Track]) -> String {
    if tracks.iter().any(|t| t.compilation == Some(true)) {
        return "Various Artists".to_string();
    }
    if let Some(b) = mode_str(tracks.iter().filter_map(|t| t.album_artist.as_deref())) {
        return b.to_string();
    }
    mode_str(tracks.iter().filter_map(|t| t.artist.as_deref()))
        .unwrap_or("Unknown Artist")
        .to_string()
}

fn derive_loved(tracks: &[&Track]) -> Option<bool> {
    if tracks.iter().any(|t| t.album_loved == Some(true)) {
        return Some(true);
    }
    let voters: Vec<bool> = tracks.iter().filter_map(|t| t.loved).collect();
    if voters.is_empty() {
        return None;
    }
    let true_count = voters.iter().filter(|v| **v).count();
    if true_count * 2 > voters.len() { Some(true) } else { None }
}

fn derive_rating(tracks: &[&Track]) -> Option<i64> {
    if let Some(ar) = tracks.iter().find_map(|t| t.album_rating) {
        return Some(ar);
    }
    let ratings: Vec<i64> = tracks.iter().filter_map(|t| t.rating).collect();
    if ratings.is_empty() {
        return None;
    }
    let avg = ratings.iter().sum::<i64>() as f64 / ratings.len() as f64;
    Some(((avg / 20.0).round() * 20.0) as i64)
}

/// Finds every track for a given artist/album, refusing to guess when the
/// query is ambiguous (e.g. matches several distinct pressings/artists).
pub fn find_album(
    tracks_map: &HashMap<String, Track>,
    artist_query: &str,
    album_query: &str,
) -> Result<MatchedAlbum, String> {
    let norm_album = normalize(album_query);
    let norm_artist = normalize(artist_query);

    let by_album: Vec<&Track> = tracks_map
        .values()
        .filter(|t| t.album.as_deref().map(normalize).as_deref() == Some(norm_album.as_str()))
        .collect();

    if by_album.is_empty() {
        let mut suggestions: Vec<&str> = tracks_map
            .values()
            .filter_map(|t| t.album.as_deref())
            .filter(|a| normalize(a).contains(&norm_album))
            .collect();
        suggestions.sort_unstable();
        suggestions.dedup();
        suggestions.truncate(10);
        return Err(format!(
            "No tracks found with album exactly matching \"{album_query}\".{}",
            if suggestions.is_empty() {
                String::new()
            } else {
                format!(" Did you mean one of: {}?", suggestions.join(", "))
            }
        ));
    }

    let by_artist: Vec<&Track> = by_album
        .iter()
        .filter(|t| {
            let effective = t.album_artist.as_deref().or(t.artist.as_deref());
            effective.map(normalize).as_deref() == Some(norm_artist.as_str())
        })
        .copied()
        .collect();

    if by_artist.is_empty() {
        let mut found_artists: Vec<&str> = by_album
            .iter()
            .filter_map(|t| t.album_artist.as_deref().or(t.artist.as_deref()))
            .collect();
        found_artists.sort_unstable();
        found_artists.dedup();
        return Err(format!(
            "Found album \"{album_query}\" but not credited to \"{artist_query}\". Artists on that album: {}",
            found_artists.join(", ")
        ));
    }

    let mut groups: HashMap<(String, String, bool), Vec<&Track>> = HashMap::new();
    for t in &by_artist {
        let key = (
            t.album.clone().unwrap_or_default(),
            t.album_artist.clone().or_else(|| t.artist.clone()).unwrap_or_default(),
            t.compilation.unwrap_or(false),
        );
        groups.entry(key).or_default().push(t);
    }

    if groups.len() > 1 {
        let mut msg = format!(
            "Ambiguous match for \"{artist_query}\" / \"{album_query}\" — {} distinct candidates:\n",
            groups.len()
        );
        for ((album, artist, compilation), group_tracks) in &groups {
            let samples: Vec<&str> = group_tracks.iter().take(2).filter_map(|t| t.name.as_deref()).collect();
            msg.push_str(&format!(
                "  - \"{album}\" by {artist} (compilation: {compilation}, {} tracks, e.g. {})\n",
                group_tracks.len(),
                samples.join(", ")
            ));
        }
        msg.push_str("Refine the artist/album strings to disambiguate.");
        return Err(msg);
    }

    let mut matched: Vec<&Track> = groups.into_values().next().unwrap();
    matched.sort_by_key(|t| (t.disc_number.unwrap_or(1), t.track_number.unwrap_or(9999), t.name.clone().unwrap_or_default()));

    let band = derive_band(&matched);
    let album_display = matched[0].album.clone().unwrap_or_else(|| album_query.to_string());
    let year = mode_year(&matched);
    let genre = mode_str(matched.iter().filter_map(|t| t.genre.as_deref())).map(|s| s.to_string());
    let loved = derive_loved(&matched);
    let rating = derive_rating(&matched);

    Ok(MatchedAlbum {
        band,
        album: album_display,
        tracks: matched.into_iter().cloned().collect(),
        year,
        genre,
        loved,
        rating,
    })
}

#[derive(Debug, Serialize)]
pub struct AlbumSummary {
    pub band: String,
    pub album: String,
    pub year: Option<i64>,
    pub genre: Option<String>,
    pub loved: Option<bool>,
    pub rating: Option<i64>,
    pub compilation: bool,
    pub track_count: usize,
    pub total_plays: i64,
    /// Soft ranking signal only (loved + rating + log-scaled plays) — not shown to the user, just used for sort order.
    pub score: f64,
}

fn score(loved: Option<bool>, rating: Option<i64>, total_plays: i64) -> f64 {
    let loved_bonus = if loved == Some(true) { 100.0 } else { 0.0 };
    let rating_score = rating.unwrap_or(0) as f64 * 0.5;
    let play_score = ((total_plays + 1) as f64).ln() * 15.0;
    loved_bonus + rating_score + play_score
}

/// Aggregates every distinct (album, artist) pairing in the library into a
/// per-album summary, for browsing/ranking rather than for filing into the vault.
pub fn list_albums(tracks_map: &HashMap<String, Track>) -> Vec<AlbumSummary> {
    let mut groups: HashMap<(String, String), Vec<&Track>> = HashMap::new();
    for t in tracks_map.values() {
        let Some(album) = t.album.clone() else { continue };
        let artist = t.album_artist.clone().or_else(|| t.artist.clone()).unwrap_or_default();
        groups.entry((album, artist)).or_default().push(t);
    }

    groups
        .into_values()
        .map(|tracks| {
            let band = derive_band(&tracks);
            let album = tracks[0].album.clone().unwrap_or_default();
            let year = mode_year(&tracks);
            let genre = mode_str(tracks.iter().filter_map(|t| t.genre.as_deref())).map(|s| s.to_string());
            let loved = derive_loved(&tracks);
            let rating = derive_rating(&tracks);
            let compilation = tracks.iter().any(|t| t.compilation == Some(true));
            let total_plays: i64 = tracks.iter().filter_map(|t| t.play_count).sum();
            let sc = score(loved, rating, total_plays);
            AlbumSummary {
                band,
                album,
                year,
                genre,
                loved,
                rating,
                compilation,
                track_count: tracks.len(),
                total_plays,
                score: sc,
            }
        })
        .collect()
}
