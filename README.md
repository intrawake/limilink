# limilink

A mobile-friendly web chat interface for the Pi agent harness.

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
