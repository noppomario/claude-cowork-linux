# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- VM path translation for `/sessions/` paths to host filesystem paths
- `vm.readFile()` method for reading files from VM filesystem with base64 encoding
- `vm.writeFile()` method for writing files to VM filesystem with base64 encoding
- `vm.isDebugLoggingEnabled()` method to check debug flag status
- `vm.stopVM()` method for clean shutdown of VM processes
- Path translation in `desktop.openFile()`, `desktop.revealFile()`, and `desktop.previewFile()`
- Path translation in `vm.spawn()` for shared working directory paths
- Path translation in process stdin data

### Security
- Path traversal protection in file read/write operations
- Secure directory creation with 0o700 permissions
- Secure file creation with 0o600 permissions
