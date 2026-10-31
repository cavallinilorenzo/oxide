// whisper.cpp links the CUDA driver API (cuda.lib), which would make Windows
// refuse to start the worker without nvcuda.dll. Delay-load it instead: every
// request first loads nvcuda.dll explicitly and reports a missing driver as a
// typed answer, before any CUDA call. The packaging checks rely on this.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg-bins=/DELAYLOAD:nvcuda.dll");
        println!("cargo:rustc-link-lib=delayimp");
    }
}
