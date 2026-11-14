# limilink

A mobile-friendly web chat interface for the Pi agent harness.

Session state defaults to `$XDG_STATE_HOME/limilink/sessions` (usually
`~/.local/state/limilink/sessions`), outside the checkout. Existing config/environment
overrides remain supported. See [state locations and cutover](doc/state-directory.md)
before moving existing sessions.

## Development
Run the server:
```sh
pdm install
pdm run build
pdm run limilink
```

To run the discord bot:

```sh
pdm lock --group discord
pdm install -G discord
pdm run limilink-discord
```

Run the checks:

```sh
pdm run test
pdm run lint
```
