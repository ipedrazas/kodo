# The kodo Gatekeeper's OpenBao policy: encrypt and decrypt users' tokens
# with one transit key, and nothing else. The Gatekeeper cannot read, export,
# rotate, reconfigure or delete the key, so it never holds key material; it
# stores only the ciphertexts transit returns.
#
# setup.sh writes this policy, with the mount and key names substituted if
# you change them from transit and kodo-gatekeeper.

path "transit/encrypt/kodo-gatekeeper" {
  capabilities = ["update"]
}

path "transit/decrypt/kodo-gatekeeper" {
  capabilities = ["update"]
}
