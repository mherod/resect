#!/bin/sh
# Stash guard for .husky/pre-commit (#153).
#
# `git stash push` returns 0 both when it creates a stash AND when there is
# nothing to stash, so the exit code alone cannot tell a caller whether a
# stash now exists. Tagging the stash message with this process's PID lets us
# positively identify "the stash we just created" before popping it, so an
# unrelated pre-existing user stash is never touched.
#
# Sourced by .husky/pre-commit and exercised directly by
# scripts/pre-commit-stash-guard.test.ts.

# Push a --keep-index stash tagged with this process's PID.
# Sets STASH_GUARD_MESSAGE and STASH_GUARD_CREATED ("1" or "0") in the caller's shell.
stash_guard_push() {
	STASH_GUARD_MESSAGE="pre-commit-stash-$$"
	git stash push --quiet --keep-index --message "$STASH_GUARD_MESSAGE"
	STASH_GUARD_CREATED=0
	if git stash list | head -1 | grep -qF "$STASH_GUARD_MESSAGE"; then
		STASH_GUARD_CREATED=1
	fi
}

# Pop the stash created by stash_guard_push, but only if it is still on top
# of the stack (defense against something else pushing a stash in between).
# No-op (with a warning) if STASH_GUARD_CREATED is not "1", or if the tagged
# stash is no longer at the top — so an unrelated stash is never popped.
stash_guard_restore() {
	if [ "$STASH_GUARD_CREATED" != "1" ]; then
		return 0
	fi
	if git stash list | head -1 | grep -qF "$STASH_GUARD_MESSAGE"; then
		git stash pop --quiet
	else
		echo "⚠️  pre-commit stash no longer at top of stack — skipping pop to avoid restoring the wrong stash. Recover manually: git stash list"
	fi
}
