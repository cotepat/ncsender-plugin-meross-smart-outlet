# Repository Setup Guide

This document explains how to set up this repository on GitHub and configure automated releases.

## Initial Setup

### 1. Create GitHub Repository

1. Go to https://github.com/new
2. Create a new repository named `ncsender-plugin-meross-smart-outlet`
3. Make it public or private (your choice)
4. Do NOT initialize with README, .gitignore, or license

### 2. Push to GitHub

```bash
cd /Users/patricecote/GitHub/ncsender-plugin-meross-smart-outlet

# Add remote origin (replace cotepat with your GitHub username)
git remote add origin https://github.com/cotepat/ncsender-plugin-meross-smart-outlet.git

# Push to GitHub
git branch -M main
git push -u origin main
```

### 3. Configure GitHub Actions

The repository includes two GitHub Actions workflows:

**test.yml** - Runs on every push/PR:
- Validates manifest.json
- Checks JavaScript syntax
- Tests package creation
- Validates package contents

**release.yml** - Runs on version tags:
- Creates plugin package
- Extracts release notes
- Creates GitHub release
- Attaches zip file

No additional configuration needed.

### 4. Create Your First Release

```bash
# Make sure you're on main branch
git checkout main

# Tag the current version (must match version in manifest.json)
git tag -a v1.0.0 -m "Release v1.0.0"

# Push the tag to trigger release workflow
git push origin v1.0.0
```

The GitHub Action will:
1. Run validation tests
2. Create the plugin package zip
3. Create a GitHub release with the zip file attached
4. Use content from `latest_release.md` as release notes

## Repository Structure

```
ncsender-plugin-meross-smart-outlet/
├── .github/
│   └── workflows/
│       ├── release.yml          # Automated releases on tags
│       └── test.yml             # Validation tests on push/PR
├── .scripts/
│   ├── extract-release-notes.sh # Extract notes from latest_release.md
│   ├── package.sh               # Create distribution zip
│   └── test-package.sh          # Test packaging locally
├── docs/
│   └── banner.html              # Optional documentation banner
├── .gitignore                   # Git ignore patterns
├── CONTRIBUTING.md              # Contribution guidelines
├── README.md                    # Main documentation
├── QUICKSTART.md                # Quick start guide
├── REPOSITORY_SETUP.md          # This file
├── index.js                     # Plugin implementation
├── latest_release.md            # Release notes for next version
├── logo.png                     # Plugin logo
└── manifest.json                # Plugin metadata
```

## Making Updates

### For Bug Fixes or Features

1. Create a branch:
   ```bash
   git checkout -b feature/my-new-feature
   ```

2. Make your changes to `index.js` or other files

3. Update `manifest.json` version

4. Update `latest_release.md` with your changes

5. Test locally:
   ```bash
   ./.scripts/test-package.sh
   ```

6. Commit and push:
   ```bash
   git add -A
   git commit -m "Description of changes"
   git push origin feature/my-new-feature
   ```

7. Create a Pull Request on GitHub

8. After merging to main, create a release tag:
   ```bash
   git checkout main
   git pull
   git tag -a v1.0.1 -m "Release v1.0.1"
   git push origin v1.0.1
   ```

## Testing Locally

```bash
# Test package creation
./.scripts/test-package.sh

# This will create a zip file you can manually install in ncSender
```

## GitHub Settings

The release workflow needs the `contents: write` permission, which is configured in `.github/workflows/release.yml`.
