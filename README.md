# cross-device-workspace

Mac/Windows both development workspace with GitHub sync.

## 1) First-time local setup

```bash
git config user.name "YOUR_NAME"
git config user.email "YOUR_EMAIL"
```

Recommended line-ending settings:

- On macOS:

```bash
git config --global core.autocrlf input
```

- On Windows:

```bash
git config --global core.autocrlf true
```

## 2) Connect to GitHub repo

1. Create an empty repo on GitHub (no README/gitignore/license).
2. Connect remote and push:

```bash
git remote add origin https://github.com/YOUR_ID/YOUR_REPO.git
git push -u origin main
```

## 3) Windows machine setup

```bash
git clone https://github.com/YOUR_ID/YOUR_REPO.git
cd YOUR_REPO
```
