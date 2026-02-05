# Contributing to Meross Smart Outlet Controller

Thank you for your interest in contributing! This document provides guidelines for contributing to this project.

## Development Setup

### Prerequisites

- ncSender v0.3.111 or later (includes Node.js runtime)
- Meross smart plug device for testing
- Git

### Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/cotepat/ncsender-plugin-meross-smart-outlet.git
   cd ncsender-plugin-meross-smart-outlet
   ```

2. **Install to ncSender** (no dependencies to install!)


   ```bash
   .scripts/install.sh
   ```

## Development Workflow

### Making Changes

1. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**
   - Edit `index.js` for plugin logic
   - Edit `meross-cloud-manager.js` for Meross API interactions
   - Update `manifest.json` if adding new features or changing metadata

3. **Test your changes**
   ```bash
   # Install updated plugin
   .scripts/install.sh
   
   # Reload plugin in ncSender
   curl -X POST http://localhost:8090/api/plugins/com.ncsender.meross-smart-outlet/reload
   ```

4. **Check logs**
   - Watch ncSender console for plugin logs
   - Look for `[PLUGIN:com.ncsender.meross-smart-outlet]` messages

### Code Style

- Use ES6+ JavaScript features
- Follow existing code formatting
- Add comments for complex logic
- Use descriptive variable names
- Keep functions focused and single-purpose

### Testing

1. **Unit Testing** (when applicable)
   - Test Meross API connection
   - Test command matching logic
   - Test outlet control functions

2. **Integration Testing**
   - Test with real Meross device
   - Test different G-code commands
   - Test multiple outlet configurations
   - Test failsafe behavior

3. **Manual Testing Checklist**
   - [ ] Plugin loads without errors
   - [ ] Settings UI displays correctly
   - [ ] Credentials can be saved
   - [ ] Connection to Meross succeeds
   - [ ] Outlets respond to G-code commands
   - [ ] Multiple commands per outlet work
   - [ ] Failsafe turns outlets OFF on unload
   - [ ] Reconnection works after network failure

## Pull Request Process

1. **Update documentation**
   - Update README.md if adding features
   - Update CHANGELOG.md with your changes
   - Add/update comments in code

2. **Commit your changes**
   ```bash
   git add .
   git commit -m "feat: add support for feature X"
   ```

3. **Push to your fork**
   ```bash
   git push origin feature/your-feature-name
   ```

4. **Create Pull Request**
   - Go to GitHub and create a PR
   - Describe your changes clearly
   - Reference any related issues

5. **Review process**
   - Address any feedback from reviewers
   - Make requested changes
   - Wait for approval

## Commit Message Format

Use conventional commits format:

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `style:` Code style changes (formatting, etc.)
- `refactor:` Code refactoring
- `test:` Adding or updating tests
- `chore:` Maintenance tasks

Examples:
```
feat: add support for 6-outlet devices
fix: correct channel indexing for multi-outlet plugs
docs: improve troubleshooting section
refactor: simplify command matching logic
```

## Feature Requests

To request a new feature:

1. Check existing issues for similar requests
2. Create a new issue with:
   - Clear description of the feature
   - Use case and benefits
   - Any implementation ideas

## Bug Reports

To report a bug:

1. Check existing issues first
2. Create a new issue with:
   - **Title**: Brief description
   - **Description**: Detailed explanation
   - **Steps to Reproduce**: Exact steps
   - **Expected Behavior**: What should happen
   - **Actual Behavior**: What actually happens
   - **Environment**: OS, ncSender version, plugin version
   - **Logs**: Relevant plugin logs

## Code of Conduct

- Be respectful and constructive
- Welcome newcomers
- Focus on the issue, not the person
- Accept constructive criticism gracefully

## Questions?

- Open an issue for general questions
- Check existing issues for answers
- Review the README and documentation first

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
