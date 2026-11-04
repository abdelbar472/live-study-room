#!/bin/bash

set -e

# Check if a commit message is provided
if [ -z "$1" ]; then
  echo "Error: Please provide a commit message."
  exit 1
fi

# Do not start another rebase while one is already in progress.
git_dir=$(git rev-parse --git-dir)
if [ -d "$git_dir/rebase-merge" ] || [ -d "$git_dir/rebase-apply" ]; then
  echo "Error: A rebase is already in progress. Run 'git rebase --continue' or 'git rebase --abort' first."
  exit 1
fi

# Add all changes
git add .

# Commit with the provided message
if ! git diff --cached --quiet; then
  git commit -m "$1"
else
  echo "No changes to commit."
fi

# Pull the latest changes before pushing
git pull --rebase origin main

# Push changes to the main branch
git push -u origin main
#./git_push.sh myapp