# Secrets (SOPS + age)

Production secrets for civfix are managed with [SOPS](https://github.com/getsops/sops) using
[age](https://github.com/FiloSottile/age) keys. This directory holds the ENCRYPTED env files that
the compose stack mounts via `env_file`. Plaintext `.env` files here are gitignored and must never
be committed.

## Files

- `.sops.yaml` (committed): rules mapping file path globs to recipient age keys.
- `api.env` / `media-worker.env` (committed ONLY in encrypted form): the per-service environment.
  In this scaffold they do not exist yet; create them from `services/api/.env.example`.

## Workflow

This step does NOT generate any keys. When you are ready to manage secrets:

1. Generate an age keypair (once per operator/CI):

   ```
   age-keygen -o age.key
   ```

   Record the PUBLIC recipient (the `age1...` line) and store `age.key` OUT of the repo
   (e.g. in your password manager or the CI secret store as `SOPS_AGE_KEY`).

2. Add the public recipient to `.sops.yaml`.

3. Create a plaintext env file (gitignored), then encrypt it in place:

   ```
   cp ../../services/api/.env.example api.env
   # edit api.env with real values
   sops --encrypt --in-place api.env
   ```

4. To run a service locally with decrypted values:

   ```
   sops --decrypt api.env > api.decrypted.env   # api.decrypted.env is gitignored
   ```

5. In CI/CD, set `SOPS_AGE_KEY` (the private key contents) as a secret; `sops --decrypt` then works
   non-interactively.

## Never

- Never commit a plaintext secret or an unencrypted `.env`.
- Never commit `age.key` or any private key material.
