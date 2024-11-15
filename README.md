# java-ts-generator

Generates TypeScript definitions from Java classes. Successor of [java-ts-bind](https://github.com/bensku/java-ts-bind).

It processes Java source code from a given Maven repository and generates TypeScript definitions for it. It is meant to be used with GraalJS to provide a strongly-typed environment.

This project is created for [CraftJS](https://github.com/raikasdev/craftjs), a [Paper](https://papermc.io/) plugin for writing plugins in JavaScript based on the previous work by [bensku](https://github.com/bensku) and [Ap3teus](https://github.com/Ap3teus). This is why the generator for example generates JavaScript getters and setters (`.name` and `.name = 'New value'` instead of `.getName()` and `.setName('New value')`).

No releases are provided for this project. Licensed under MIT, you are free to use and modify it to your liking.

## Usage

You need to have [Bun](https://bun.sh/) installed to use this tool. Run `bun install` to install the dependencies.

You may use the first or second argument to provide a path to a configuration file or the output directory. By default these are PaperMC + Adventure and `./output`.

```bash
bun run generate [path/to/config.json] [path/to/output/directory]
```

### Configuration file

The configuration file is a JSON file that contains an array of objects:

| Name | Description | Required |
|------|-------------|----------|
| type | Either "maven" or "zip" | Yes |
| repository | Maven repository URL | Only for maven |
| artifact | Maven artifact coordinates (groupId:artifactId:version) | Only for maven |
| zipPath | Path to source zip file | Only for zip |
| include | Array of package names to include (e.g. ["java.lang", "java.util"]) | No |
| exclude | Array of package names to exclude | No |
| offset | Directory inside zip to use as root (only for zip) | No |

## Limitations

Even though I strive for fully valid typings, please note that java-ts-generator might not generate 100 % valid TypeScript declarations. If you encounter problems, please try using `noLibCheck` in your `tsconfig.json`.

Please also note that java-ts-generator provides only the types. Implementing a module loading system for importing them is left as an exercise for the reader. For pointers, see [CraftJS](https://github.com/raikasdev/craftjs) which (at time of writing) implements a CommonJS module loader with Java and TypeScript.


## TODO

- [x] Constructors
- [ ] Records
- [x] Investigate weird edge case on org.bukkit.scoreboard.Criteria where getName() get's all the modifiers
- spread parameters (...components)
