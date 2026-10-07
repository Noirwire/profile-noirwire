//! Tells the program whether this build was told which release and commit
//! it comes from. Both `SOURCE_RELEASE` and `SOURCE_REVISION` must be set
//! for either to be embedded; a build that sets neither embeds neither.

const STAMPS: [&str; 2] = ["SOURCE_RELEASE", "SOURCE_REVISION"];

fn main() {
    println!("cargo:rustc-check-cfg=cfg(source_stamped)");
    for stamp in STAMPS {
        println!("cargo:rerun-if-env-changed={stamp}");
    }
    let is_set = |stamp: &&str| std::env::var(stamp).is_ok_and(|value| !value.is_empty());
    if STAMPS.iter().all(is_set) {
        println!("cargo:rustc-cfg=source_stamped");
    }
}
