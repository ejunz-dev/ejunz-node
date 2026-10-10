# `@ejunz/ea`


`ea` is the command-line launcher for Agent profiles and remote Agent runtimes.

```sh
ea --profile headless "task"  # run one task and exit
ea node                     # connect this runtime to its Ejunz host
ea plugin --profile headless add <package>
```

Profiles are ordered stacks of bundles and Cordis patch layers. Inspect a profile with `--dump-config` or `--dump-default-config`.
