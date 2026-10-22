# Bundled media tools

Release builds place platform-specific binaries in this directory before running
the Tauri bundler:

```text
media-tools/
├── darwin-arm64/ffmpeg
├── darwin-arm64/yt-dlp
├── win32-x64/ffmpeg.exe
├── win32-x64/yt-dlp.exe
└── linux-x64/...
```

The application resolves `MEDIA_TOOLS_DIR/<platform>-<arch>/` first. Keep the
tool versions pinned in the release workflow and ship the corresponding
third-party license notices with the release artifacts.

Use `MEDIA_TOOLS_SOURCE_DIR=/path/to/staged-tools pnpm stage:desktop-tools` to
copy the current host's binaries into the expected directory.
