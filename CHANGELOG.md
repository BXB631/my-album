# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/).

## [1.11.0] - 2026-10-21

### Added

- Electron desktop application with a native Windows window.
- Native folder picker, desktop shortcut, Start Menu shortcut and uninstaller.
- Local JSON library index with incremental refresh and directory signature checks.
- FFmpeg-based fast video probing and HEIC conversion worker pool.
- Progressive timeline rendering for very large libraries.
- Photo map, EXIF details, city labels and cache management.
- GitHub-friendly build and release workflows.

### Changed

- User data moved to `%APPDATA%\MyAlbum` for installed builds.
- Thumbnails reduced to 320 px, JPEG quality 65.
- Video playback falls back to the system player when PotPlayer is unavailable.

### Fixed

- Reduced blocking when generating HEIC thumbnails.
- Avoided rebuilding the entire photo index when only opening the app.
- Improved refresh behavior while a large library is already displayed.
