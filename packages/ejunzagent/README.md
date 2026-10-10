# ejunz-agent


Ejunz Agent runtime and command-line launcher. The embedded Host API bundle has no browser UI.

## Development (from source)

```sh
yarn install
yarn ea --profile headless "task"  # run one task and exit
yarn ea node                        # join an Ejunz host
```

## Production

```sh
npm install -g @ejunz/ea
ea --profile headless "task"
ea node
```

Real-model runs need `DEEPSEEK_API_KEY` in the root `.env`.
