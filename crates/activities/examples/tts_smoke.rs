use chriscord_activities::dj::{PlaceholderTts, Tts};
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let output = std::env::args().nth(1).expect("output WAV path required");
    PlaceholderTts {
        espeak_ng: "espeak-ng".into(),
    }
    .synthesize(
        "Chriscord local placeholder voice. Next up, a song for our friends.",
        std::path::Path::new(&output),
    )
    .await
    .expect("local speech synthesis");
    println!("Local placeholder synthesis produced a validated WAV");
}
