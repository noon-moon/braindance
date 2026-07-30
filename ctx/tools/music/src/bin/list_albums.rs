use add_album::apple_music;
use clap::Parser;
use std::path::PathBuf;
use std::process::exit;

/// Dumps a ranked, filtered summary of every album in the Apple Music export
/// as JSON, for browsing candidates to write full vault notes for. This never
/// touches the vault — it's read-only analysis of the library export.
#[derive(Parser)]
#[command(name = "list-albums")]
struct Args {
    #[arg(long)]
    library: Option<PathBuf>,
    /// Minimum total play count to include an album with no loved/rating signal
    #[arg(long, default_value_t = 3)]
    min_plays: i64,
}

fn default_library() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../assets/AppleMusic.xml")
}

fn main() {
    let args = Args::parse();
    let library_path = args.library.unwrap_or_else(default_library);

    let library = match apple_music::load_library(&library_path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("{e}");
            exit(2);
        }
    };

    let mut albums = apple_music::list_albums(&library.tracks);
    albums.retain(|a| a.loved == Some(true) || a.rating.is_some() || a.total_plays >= args.min_plays);
    albums.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());

    println!("{}", serde_json::to_string_pretty(&albums).unwrap());
    eprintln!("{} albums with signal (out of library total)", albums.len());
}
