#!/bin/bash
# Resolve merge conflicts and merge open forgectl PRs in order.
# Uses Claude Code to intelligently resolve conflicts.
set -e

REPO="rahul-fnu/outspoken"
WORKDIR=$(mktemp -d)
echo "Working in: $WORKDIR"

cd "$WORKDIR"
git clone "https://github.com/$REPO.git" . 2>&1 | tail -1
git config user.name "forgectl"
git config user.email "forge@localhost"

# Get open PRs in order
PRS=$(gh pr list --repo "$REPO" --state open --json number --jq '.[].number' | sort -n)

for PR in $PRS; do
  BRANCH=$(gh pr view "$PR" --repo "$REPO" --json headRefName --jq '.headRefName')
  TITLE=$(gh pr view "$PR" --repo "$REPO" --json title --jq '.title')
  echo ""
  echo "=== PR #$PR: $TITLE ==="
  echo "    Branch: $BRANCH"

  # Fetch the branch
  git fetch origin "$BRANCH" 2>&1 | tail -1

  # Try merge
  if git merge "origin/$BRANCH" --no-edit 2>/dev/null; then
    echo "    ✅ Merged cleanly"
  else
    # Get conflicted files
    CONFLICTS=$(git diff --name-only --diff-filter=U)
    echo "    ⚠ Conflicts in: $(echo $CONFLICTS | tr '\n' ' ')"

    # For each conflicted file, use Claude to resolve
    for FILE in $CONFLICTS; do
      echo "    Resolving: $FILE"
      # Get the three versions
      git show :1:"$FILE" > /tmp/base.txt 2>/dev/null || echo "" > /tmp/base.txt
      git show :2:"$FILE" > /tmp/ours.txt 2>/dev/null || echo "" > /tmp/ours.txt
      git show :3:"$FILE" > /tmp/theirs.txt 2>/dev/null || echo "" > /tmp/theirs.txt

      # Use Claude to merge
      PROMPT="Merge these three versions of $FILE. Output ONLY the merged file content, no explanation.

=== BASE (common ancestor) ===
$(cat /tmp/base.txt)

=== OURS (current main) ===
$(cat /tmp/ours.txt)

=== THEIRS (PR branch - this is the new feature) ===
$(cat /tmp/theirs.txt)

Rules:
- Include ALL content from both OURS and THEIRS
- For code files: combine imports, merge function lists, keep all features
- For config files: merge all entries
- Do not duplicate identical lines
- Output the complete merged file"

      RESOLVED=$(echo "$PROMPT" | claude -p - --output-format text --dangerously-skip-permissions --max-turns 1 2>/dev/null)

      if [ -n "$RESOLVED" ]; then
        echo "$RESOLVED" > "$FILE"
        git add "$FILE"
        echo "    ✅ Resolved: $FILE"
      else
        # Fallback: take theirs (the new feature)
        git checkout --theirs "$FILE"
        git add "$FILE"
        echo "    ⚠ Fallback (theirs): $FILE"
      fi
    done

    git commit --no-edit 2>/dev/null || git commit -m "Merge $BRANCH with conflict resolution"
    echo "    ✅ Merge committed"
  fi

  # Push updated main
  git push origin main 2>&1 | tail -1
  echo "    ✅ Pushed to main"

  # Close the PR (it's now merged via main)
  gh pr close "$PR" --repo "$REPO" --comment "Merged to main via conflict resolution." 2>/dev/null
  echo "    ✅ PR #$PR closed"
done

echo ""
echo "=== Done ==="
rm -rf "$WORKDIR"
