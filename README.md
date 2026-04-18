# limilink

A mobile-friendly web chat proxy to bridge the dreamscape persona via `gemini-cli`.

## Development
Run the server:
```sh
pdm install
pdm run limilink
```

To run the discord bot:

```sh
pdm lock --group discord
pdm install -G discord
pdm run limilink-discord
```
