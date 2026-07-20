use add_album::apple_music;
use add_album::vault_notes;
use clap::Parser;
use std::path::PathBuf;
use std::process::exit;

/// Adds a band/genre/album/song graph to the braindance vault, sourced from
/// an Apple Music library export. Safe to rerun: existing notes are merged,
/// never clobbered, and song memos are create-only.
#[derive(Parser)]
#[command(name = "add-album")]
struct Args {
    artist: String,
    album: String,
    /// Also file the album under Record Collection.md (physically owned records)
    #[arg(long)]
    owned: bool,
    /// Print what would happen without writing anything
    #[arg(long)]
    dry_run: bool,
    #[arg(long)]
    library: Option<PathBuf>,
    #[arg(long)]
    vault: Option<PathBuf>,
}

fn default_library() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../assets/AppleMusic.xml")
}

fn default_vault() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vault")
}

fn report(result: Result<(PathBuf, vault_notes::Action), String>) {
    match result {
        Ok((path, action)) => {
            let label = match action {
                vault_notes::Action::Created => "CREATE",
                vault_notes::Action::Updated => "UPDATE",
                vault_notes::Action::Unchanged => "UNCHANGED",
            };
            println!("[{label}] {}", path.file_name().unwrap().to_string_lossy());
        }
        Err(e) => {
            eprintln!("Error: {e}");
            exit(2);
        }
    }
}

fn main() {
    let args = Args::parse();
    let library_path = args.library.clone().unwrap_or_else(default_library);
    let vault_path = args.vault.clone().unwrap_or_else(default_vault);

    let library = match apple_music::load_library(&library_path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("{e}");
            exit(2);
        }
    };

    let matched = match apple_music::find_album(&library.tracks, &args.artist, &args.album) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("{e}");
            exit(1);
        }
    };

    if args.dry_run {
        println!("[DRY RUN] no files will be written");
    }
    println!("Matched \"{}\" by {} ({} tracks)", matched.album, matched.band, matched.tracks.len());

    let band_link = vault_notes::wikilink(&matched.band);
    let album_link = vault_notes::wikilink(&format!("{} - {}", matched.band, matched.album));

    if let Some(genre) = &matched.genre {
        let genre_link = vault_notes::wikilink(genre);
        report(vault_notes::ensure_music_criticism_contains(&vault_path, &genre_link, args.dry_run));
        report(vault_notes::ensure_genre_scope(&vault_path, genre, &band_link, args.dry_run));
        report(vault_notes::ensure_band_scope(&vault_path, &matched.band, &album_link, Some(&genre_link), args.dry_run));
    } else {
        eprintln!("Warning: no genre found on any matched track — filing band without a genre parent.");
        report(vault_notes::ensure_band_scope(&vault_path, &matched.band, &album_link, None, args.dry_run));
    }

    let song_links: Vec<String> = matched
        .tracks
        .iter()
        .map(|t| vault_notes::wikilink(&format!("{} - {} - {}", matched.band, matched.album, t.name.as_deref().unwrap_or("Untitled"))))
        .collect();

    let album_meta = vault_notes::AlbumMeta {
        year: matched.year,
        genre: matched.genre.clone(),
        loved: matched.loved,
        rating: matched.rating,
    };
    report(vault_notes::ensure_album_scope(
        &vault_path,
        &matched.band,
        &matched.album,
        &band_link,
        &song_links,
        &album_meta,
        args.owned,
        args.dry_run,
    ));

    for t in &matched.tracks {
        let song = t.name.as_deref().unwrap_or("Untitled");
        let song_meta = vault_notes::SongMeta {
            track_number: t.track_number,
            duration_ms: t.total_time_ms,
            rating: t.rating,
            loved: t.loved,
        };
        report(vault_notes::ensure_song_memo(&vault_path, &matched.band, &matched.album, song, &song_meta, args.dry_run));
    }

    if args.owned {
        report(vault_notes::ensure_record_collection(&vault_path, &album_link, args.dry_run));
    }
}
