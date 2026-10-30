fn main() {
    println!("cargo:rerun-if-changed=native");
    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .include("native/whisper-1.8.3")
        .file("native/dispatch.cpp")
        .compile("oxide_dispatch");
}
