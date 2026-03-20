#!/usr/bin/env bash
set -euo pipefail

SIGN_KEY="${GPG_SIGN_KEY:-60BFBD78D728EEE4}"
OP_ENV="${OPENCODE_MANIFEST_SIGN_1PASSWORD_ENV_ID:-weksim7ulja7rrhkaap3lxk2wa}"
OP_ACCOUNT="${OPENCODE_MANIFEST_SIGN_1PASSWORD_ACCOUNT:-}"
OP_VAR="${OPENCODE_MANIFEST_SIGN_1PASSWORD_VAR:-OPENCODE_MANIFEST_SIGN_PASSPHRASE}"

# Resolve passphrase via 1Password environment
resolve_passphrase() {
  local -a op_args
  op_args=(environment read "$OP_ENV")
  [[ -n "$OP_ACCOUNT" ]] && op_args+=(--account "$OP_ACCOUNT")

  local env_output line key value
  env_output="$(OP_DISABLE_PROMPTS=1 op "${op_args[@]}" 2>/dev/null)" || {
    echo "Failed to read 1Password environment '$OP_ENV'" >&2; exit 1
  }

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    if [[ "$key" == "$OP_VAR" ]]; then
      printf '%s' "$value"
      return 0
    fi
  done <<< "$env_output"

  echo "Variable '$OP_VAR' not found in environment '$OP_ENV'" >&2
  exit 1
}

keygrip_for_sign_key() {
  local line keygrip
  while IFS= read -r line; do
    case "$line" in
      grp:*)
        keygrip="${line#grp:::::::::}"
        keygrip="${keygrip%%:*}"
        [[ -n "$keygrip" ]] && { printf '%s' "$keygrip"; return 0; }
        ;;
    esac
  done < <(gpg --with-colons --with-keygrip --list-secret-keys "$SIGN_KEY" 2>/dev/null)
  return 1
}

SIGN_PASSPHRASE="$(resolve_passphrase)"

libexecdir="$(gpgconf --list-dirs libexecdir 2>/dev/null)"
preset_bin="${libexecdir%/}/gpg-preset-passphrase"
[[ ! -x "$preset_bin" ]] && preset_bin="$(command -v gpg-preset-passphrase 2>/dev/null || true)"
[[ -z "$preset_bin" || ! -x "$preset_bin" ]] && { echo "gpg-preset-passphrase not found" >&2; exit 1; }

keygrip="$(keygrip_for_sign_key)"
[[ -z "$keygrip" ]] && { echo "Could not get keygrip for $SIGN_KEY" >&2; exit 1; }

"$preset_bin" -c -P "$SIGN_PASSPHRASE" "$keygrip"
echo "GPG agent unlocked for key $SIGN_KEY"
