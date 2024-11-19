import {
  Class,
  Enum,
  Interface,
  parse,
  Record,
  TypeDeclaration,
} from "../java-model";
import fs from "fs/promises";
import type { GenericDefinition, TypeDefinition } from "./types";
import {
  GenericInterfaceMethodDeclarationContext,
  GenericMethodDeclarationContext,
  LastFormalParameterContext,
  MethodDeclarationContext,
} from "java-ast";

function tryType(
  type: TypeDeclaration,
  typeName: string,
  dependencyTypes: string[],
) {
  typeName = typeName
    .replaceAll("?super", "")
    .replaceAll("?extends", "")
    .replaceAll("@NotNull", "");

  let array = false;
  if (typeName.endsWith("[]")) {
    array = true;
    typeName = typeName.slice(0, -2);
  }
  const native = [
    "void",
    "boolean",
    "byte",
    "short",
    "int",
    "long",
    "float",
    "double",
    "char",
    "String",
    "Object",
    "?",
  ];
  if (native.includes(typeName) || typeName.split(".").length > 3) {
    return array ? `${typeName}[]` : typeName; // Should already be resolved
  }

  try {
    const t = type.project().resolve(type, typeName, dependencyTypes).canonicalName();
    return array ? `${t}[]` : t;
  } catch (e) {
    console.error("Failed to resolve", typeName, "in", type.canonicalName());
    return array ? `${typeName}[]` : typeName;
  }
}

function parseJavaDoc(docString: string): string[] {
  // Remove the opening /** and closing **/ along with any leading asterisks
  const cleanDoc = docString
    .replace(/^\/\*\*\s*/, "") // Remove opening /**
    .replace(/\s*\*+\/$/, "") // Remove closing */
    .split("\n") // Split into lines
    .map(
      (line) =>
        line
          .replace(/^\s*\*\s?/, "") // Remove leading asterisks and spaces
          .trim(), // Remove any remaining whitespace
    ); // Remove empty lines after trimming

  return cleanDoc;
}

function replaceIllegalParameters(name: string) {
  const reserved = [
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "function",
    "if",
    "import",
    "in",
    "instanceof",
    "new",
    "null",
    "return",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
  ];
  if (reserved.includes(name)) {
    return `${name}Parameter`;
  }

  return name;
}

function parseGeneric(
  type: TypeDeclaration,
  name: string,
  dependencyTypes: string[],
) {
  let fixed = false;
  const definition: GenericDefinition = {
    name,
    nullable: type.annotations.some((i) => i.qualifiedName === "Nullable"),
  };
  const inner = name.match(/<(.*)>/);
  if (inner) {
    definition.name = tryType(
      type,
      definition.name.slice(0, inner.index),
      dependencyTypes,
    );
    fixed = true;

    const topLevelGenerics = inner[1].match(/([^,<]+(?:<[^>]+>)?[^,]*)/g);
    if (!topLevelGenerics) return definition;

    topLevelGenerics
      .map((i) => i.trim())
      .forEach((i) => {
        if (!definition.generics) definition.generics = [];
        definition.generics.push(parseGeneric(type, i, dependencyTypes));
      });
  }

  if (!fixed) {
    definition.name = tryType(type, definition.name, dependencyTypes);
  }

  return definition;
}

export async function processJavaSource(
  files: string[],
  dependencyTypes: string[],
): Promise<TypeDefinition[]> {
  const JETBRAINS_ANNOTATIONS = [
    "NotNull",
    "Nullable",
    "Unmodifiable",
    "UnknownNullability",
  ];
  const file = await parse({
    files,
    readAsync: async (file) => {
      let content = await fs.readFile(file, "utf-8");
      // Remove annotations to easen parsing
      for (const annotation of JETBRAINS_ANNOTATIONS) {
        content = content.replaceAll(
          `\\.@org.jetbrains.annotations.${annotation} `,
          "",
        );
        content = content.replaceAll(
          `@org.jetbrains.annotations.${annotation} `,
          "",
        );
        content = content.replaceAll(`@${annotation} `, "");
        content = content.replaceAll(`@${annotation}\\.\\.\\.`, "...");
      }
      return content;
    },
  });
  let packageName = "";
  let moduleTypes: TypeDefinition[] = [];

  file.visitTypes((type) => {
    const packageParts = type.canonicalName().split(".");
    packageParts.pop();
    packageName = packageParts.join(".");

    if (type.name.endsWith("Impl")) return; // Ignore implementations
    if (
      type.modifiers.includes("private") ||
      type.modifiers.includes("protected")
    )
      return;
    let definition: TypeDefinition | null = null;
    if (type instanceof Enum) {
      // Enums are classes of type java.lang.Enum<T> T being self
      const fields = type.fields
        .filter((i) => i.modifiers.includes("public"))
        .map((field) => ({
          name: field.name,
          type: tryType(type, field.type.qualifiedName, dependencyTypes),
          readonly: field.modifiers.includes("final"),
          static: field.modifiers.includes("static"),
        }));

      type.constants.forEach((c) => {
        fields.push({
          static: true,
          readonly: true,
          name: c.name,
          type: `${packageName}.${type.name}`,
        });
      });

      const methods = type.methods
        .filter((i) => i.modifiers.includes("public"))
        .map((method) => {
          let fullType = method.type.qualifiedName;
          if (method.context instanceof MethodDeclarationContext) {
            fullType = method.context.typeTypeOrVoid().text;
          } else if (
            method.context instanceof GenericMethodDeclarationContext
          ) {
            fullType = method.context.methodDeclaration().typeTypeOrVoid().text;
          } else {
            fullType = method.context
              .interfaceCommonBodyDeclaration()!
              .typeTypeOrVoid().text;
          }

          return {
            name: method.name,
            parameters: method.parameters.map((param) => {
              const paramType = param.context.typeType().text;

              return {
                name: replaceIllegalParameters(param.name),
                type: parseGeneric(type, paramType, dependencyTypes),
                spread:
                  param.context instanceof LastFormalParameterContext &&
                  !!param.context.ELLIPSIS(),
                nullable: param.annotations.some(
                  (i) => i.qualifiedName === "Nullable",
                ),
              };
            }),
            returnType: parseGeneric(type, fullType, dependencyTypes),
            static: method.modifiers.includes("static"),
            javadocs: method.javadoc ? parseJavaDoc(method.javadoc) : undefined,
          };
        });

      methods.push({
        name: "valueOf",
        returnType: {
          name: type.name,
          nullable: false,
        },
        parameters: [
          {
            name: "name",
            type: {
              name: "String",
              nullable: false,
            },
            spread: false,
            nullable: false,
          },
        ],
        static: true,
        javadocs: undefined,
      });

      methods.push({
        name: "values",
        returnType: {
          name: `java.util.List<${type.name}>`,
          nullable: false,
        },
        parameters: [],
        static: true,
        javadocs: undefined,
      });

      definition = {
        name: type.name,
        package: packageName,
        fields,
        constructors: type.constructors
          .filter((i) => i.modifiers.includes("public"))
          .map((c) => ({
            parameters: c.parameters.map((param) => {
              const paramType = param.context.typeType().text;

              return {
                name: replaceIllegalParameters(param.name),
                type: parseGeneric(type, paramType, dependencyTypes),
                spread:
                  param.context instanceof LastFormalParameterContext &&
                  !!param.context.ELLIPSIS(),
                nullable: param.annotations.some(
                  (i) => i.qualifiedName === "Nullable",
                ),
              };
            }),
          })),
        methods,
        type: "class",
        interfaces: [],
        superclass: {
          name: "java.lang.Enum",
          generics: [{ name: type.name, nullable: false }],
          nullable: false,
        },
      };
    } else if (type instanceof Interface) {
      let interfaceGenerics: GenericDefinition[] = [];
      const typeParams = type.context.typeParameters();
      if (typeParams) {
        for (const typeParam of typeParams.typeParameter()) {
          const extendsArr = [];
          for (const paramType of typeParam.typeBound()?.typeType() ?? []) {
            if (!paramType) continue;
            extendsArr.push(
              parseGeneric(type, paramType.text, dependencyTypes),
            );
          }
          interfaceGenerics.push({
            name: typeParam.identifier().text,
            extends: extendsArr,
            nullable: false,
          });
        }
      }

      definition = {
        name: type.name,
        package: packageName,
        methods: type.methods
          .filter(
            (i) =>
              !i.modifiers.includes("private") &&
              !i.modifiers.includes("protected"),
          )
          .map((method) => {
            let generics: GenericDefinition[] = [];
            if (
              method.context instanceof GenericInterfaceMethodDeclarationContext
            ) {
              for (const typeParam of method.context
                .typeParameters()
                .typeParameter()) {
                const extendsArr = [];
                for (const paramType of typeParam.typeBound()?.typeType() ??
                  []) {
                  if (!paramType) continue;
                  extendsArr.push(
                    parseGeneric(type, paramType.text, dependencyTypes),
                  );
                }

                generics.push({
                  name: typeParam.identifier().text,
                  extends: extendsArr,
                  nullable: false,
                });
              }
            }
            let fullType = method.type.qualifiedName;
            if (method.context instanceof MethodDeclarationContext) {
              fullType = method.context.typeTypeOrVoid().text;
            } else if (
              method.context instanceof GenericMethodDeclarationContext
            ) {
              fullType = method.context
                .methodDeclaration()
                .typeTypeOrVoid().text;
            } else {
              fullType = method.context
                .interfaceCommonBodyDeclaration()!
                .typeTypeOrVoid().text;
            }

            return {
              name: method.name,
              parameters: method.parameters.map((param) => {
                const paramType = param.context.typeType().text;
                return {
                  name: replaceIllegalParameters(param.name),
                  type: parseGeneric(type, paramType, dependencyTypes),
                  spread:
                    param.context instanceof LastFormalParameterContext &&
                    !!param.context.ELLIPSIS(),
                  nullable: param.annotations.some(
                    (i) => i.qualifiedName === "Nullable",
                  ),
                };
              }),
              returnType: parseGeneric(type, fullType, dependencyTypes),
              generics,
              static: method.modifiers.includes("static"),
              javadocs: method.javadoc
                ? parseJavaDoc(method.javadoc)
                : undefined,
            };
          }),
        fields: type.fields.map((field) => ({
          name: field.name,
          type: tryType(type, field.type.qualifiedName, dependencyTypes),
          readonly: true,
          static: true,
        })),
        type: "interface",
        interfaces: type.modifiers.includes("sealed")
          ? []
          : type.interfaces.map((i) => ({
              name: i.canonicalName(),
              generics:
                i.arguments.length === 0
                  ? undefined
                  : i.arguments.map((i) =>
                      parseGeneric(type, i.name, dependencyTypes),
                    ),
              nullable: false,
            })),
        generics: interfaceGenerics,
      };
    } else if (type instanceof Class) {
      let classGenerics: GenericDefinition[] = [];
      const typeParams = type.context.typeParameters();
      if (typeParams) {
        for (const typeParam of typeParams.typeParameter()) {
          const extendsArr = [];
          for (const paramType of typeParam.typeBound()?.typeType() ?? []) {
            if (!paramType) continue;
            extendsArr.push(
              parseGeneric(type, paramType.text, dependencyTypes),
            );
          }
          classGenerics.push({
            name: typeParam.identifier().text,
            extends: extendsArr,
            nullable: false,
          });
        }
      }

      definition = {
        name: type.name,
        package: packageName,
        constructors: type.constructors
          .filter((i) => i.modifiers.includes("public"))
          .map((c) => ({
            parameters: c.parameters.map((param) => {
              const paramType = param.context.typeType().text;

              return {
                name: replaceIllegalParameters(param.name),
                type: parseGeneric(type, paramType, dependencyTypes),
                spread:
                  param.context instanceof LastFormalParameterContext &&
                  !!param.context.ELLIPSIS(),
                nullable: param.annotations.some(
                  (i) => i.qualifiedName === "Nullable",
                ),
              };
            }),
          })),
        fields: type.fields
          .filter((i) => i.modifiers.includes("public"))
          .map((field) => ({
            name: field.name,
            type: tryType(type, field.type.qualifiedName, dependencyTypes),
            readonly: field.modifiers.includes("final"),
            static: field.modifiers.includes("static"),
          })),
        methods: type.methods
          .filter((i) => i.modifiers.includes("public"))
          .map((method) => {
            let generics: GenericDefinition[] = [];
            if (method.context instanceof GenericMethodDeclarationContext) {
              for (const typeParam of method.context
                .typeParameters()
                .typeParameter()) {
                const extendsArr = [];
                for (const paramType of typeParam.typeBound()?.typeType() ??
                  []) {
                  if (!paramType) continue;
                  extendsArr.push(
                    parseGeneric(type, paramType.text, dependencyTypes),
                  );
                }
                generics.push({
                  name: typeParam.identifier().text,
                  extends: extendsArr,
                  nullable: false,
                });
              }
            }

            let fullType = method.type.qualifiedName;
            if (method.context instanceof MethodDeclarationContext) {
              fullType = method.context.typeTypeOrVoid().text;
            } else if (
              method.context instanceof GenericMethodDeclarationContext
            ) {
              fullType = method.context
                .methodDeclaration()
                .typeTypeOrVoid().text;
            } else {
              fullType = method.context
                .interfaceCommonBodyDeclaration()!
                .typeTypeOrVoid().text;
            }

            return {
              name: method.name,
              parameters: method.parameters.map((param) => {
                const paramType = param.context.typeType().text;

                return {
                  name: replaceIllegalParameters(param.name),
                  type: parseGeneric(type, paramType, dependencyTypes),
                  spread:
                    param.context instanceof LastFormalParameterContext &&
                    !!param.context.ELLIPSIS(),
                  nullable: param.annotations.some(
                    (i) => i.qualifiedName === "Nullable",
                  ),
                };
              }),
              returnType: parseGeneric(type, fullType, dependencyTypes),
              generics,
              static: method.modifiers.includes("static"),
              javadocs: method.javadoc
                ? parseJavaDoc(method.javadoc)
                : undefined,
            };
          }),
        type: "class",
        interfaces: type.interfaces.map((i) => ({
          name: i.canonicalName(),
          generics:
            i.arguments.length === 0
              ? undefined
              : i.arguments.map((i) =>
                  parseGeneric(type, i.name, dependencyTypes),
                ),
          nullable: false,
        })),
        superclass: type.superclass
          ? {
              name: type.superclass.canonicalName(),
              generics:
                type.superclass.arguments.length === 0
                  ? undefined
                  : type.superclass.arguments.map((i) =>
                      parseGeneric(type, i.name, dependencyTypes),
                    ),
              nullable: false,
            }
          : undefined,
        generics: classGenerics,
      };
    }

    if (!definition) return;

    moduleTypes.push(definition);
  });

  return moduleTypes;
}
