import { Class, Enum, Interface, parse, Record, TypeDeclaration } from "../java-model";
import fs from 'fs/promises';
import type { GenericDefinition, TypeDefinition } from "./types";
import { GenericInterfaceMethodDeclarationContext } from "java-ast";

function tryType(type: TypeDeclaration, typeName: string) {
  let array = false;
  if (typeName.endsWith("[]")) {
    array = true;
    typeName = typeName.slice(0, -2);
  }
  const native = [
    'void',
    'boolean',
    'byte',
    'short',
    'int',
    'long',
    'float',
    'double',
    'char',
    'String',
    'Object'
  ];
  if (native.includes(typeName) || typeName.split(".").length > 2) {
    return array ? `${typeName}[]` : typeName; // Should already be resolved
  }

  try {
    const t = type.project().resolve(type, typeName).canonicalName();
    return array ? `${t}[]` : t;
  } catch (e) {
    console.error('Failed to resolve', type.canonicalName());
    return array ? `${typeName}[]` : typeName;
  }
}

function replaceIllegalParameters(name: string) {
  const reserved = [
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'default',
    'delete',
    'do',
    'else',
    'enum',
    'export',
    'extends',
    'false',
    'finally',
    'for',
    'function',
    'if',
    'import',
    'in',
    'instanceof',
    'new',
    'null',
    'return',
    'super',
    'switch',
    'this',
    'throw',
    'true',
    'try',
    'typeof',
    'var',
    'void',
    'while',
    'with',
  ];
  if (reserved.includes(name)) {
    return `${name}Parameter`;
  }

  return name;
}

export async function processJavaSource(files: string[]): Promise<TypeDefinition[]> {
  const file = await parse({ files, readAsync: async (file) => fs.readFile(file, 'utf-8') });
  let packageName = '';
  let moduleTypes: TypeDefinition[] = [];

  file.visitTypes((type) => {
    const packageParts = type.canonicalName().split('.');
    packageParts.pop();
    packageName = packageParts.join(".");

    if (!type.modifiers.includes("public")) return;

    let definition: TypeDefinition | null = null;
    if (type instanceof Enum) {
      // Enums are classes of type java.lang.Enum<T> T being self
      const fields = type.fields.filter((i) => i.modifiers.includes("public")).map((field) => ({ 
        name: field.name,
        type: tryType(type, field.type.qualifiedName),
        readonly: field.modifiers.includes("final"),
        static: field.modifiers.includes("static"),
      }));

      type.constants.forEach(c => {
        fields.push({
          static: true,
          readonly: true,
          name: c.name,
          type: `${packageName}.${type.name}`
        })
      });

      definition = {
        name: type.name,
        package: packageName,
        fields,
        constructors: type.constructors.filter((i) => i.modifiers.includes("public")).map((c) => ({
          parameters: c.parameters.map((param) => {
            const paramType = param.context.typeType().text;
            const definition: GenericDefinition = {
              name: param.type.qualifiedName,
            }
            const inner = paramType?.match(/<(.*)>$/);
            if (paramType && inner) {
              const innerInner = inner[1].match(/<(.*)>$/);
              definition.superclass = {
                name: (innerInner ? inner[1].slice(0, innerInner.index) : inner[1]).replace('?super', '').replace('?extends', '').replace('@NotNull', ''),
                superclass: innerInner ? {
                  name: innerInner[1].replace('?super', '').replace('?extends', '').replace('@NotNull', ''), // In typescript "extends X" is not required
                } : undefined,
              }
            }
            

            return {
              name: replaceIllegalParameters(param.name),
              type: definition,
            }})
          })),
        methods: type.methods.filter((i) => i.modifiers.includes("public")).map((method) => ({
          name: method.name,
          parameters: method.parameters.map((param) => {
            const paramType = param.context.typeType().text;
            const definition: GenericDefinition = {
              name: param.type.qualifiedName,
            }
            const inner = paramType?.match(/<(.*)>$/);
            if (paramType && inner) {
              const innerInner = inner[1].match(/<(.*)>$/);
              definition.superclass = {
                name: (innerInner ? inner[1].slice(0, innerInner.index) : inner[1]).replace('?super', '').replace('?extends', '').replace('@NotNull', ''),
                superclass: innerInner ? {
                  name: innerInner[1].replace('?super', '').replace('?extends', '').replace('@NotNull', ''), // In typescript "extends X" is not required
                } : undefined,
              }
            }
            

            return {
              name: replaceIllegalParameters(param.name),
              type: definition,
            }}),
          returnType: tryType(type, method.type.qualifiedName),
          static: method.modifiers.includes("static"),
        })),
        type: 'class',
        interfaces: [],
        superclass: `java.lang.Enum<${type.name}>`,
      }
    } else if (type instanceof Interface) {
      let interfaceGenerics: GenericDefinition[] = [];
      const typeParams = type.context.typeParameters();
      if (typeParams) {
        for (const typeParam of typeParams.typeParameter()) {
          const paramType = typeParam.typeBound()?.typeType()[0].text;
          const definition: GenericDefinition = {
            name: typeParam.identifier().text,
            superclass: paramType ? {
              name: tryType(type, paramType),
            } : undefined
          }
          const inner = paramType?.match(/<(.*)>$/);
          if (paramType && inner) {
            definition.superclass = {
              name: tryType(type, paramType.slice(0, inner.index)),
              superclass: {
                name: inner[1].replace('?super', '').replace('?extends', '').replace('@NotNull', ''), // In typescript "extends X" is not required
              }
            }
          }

          interfaceGenerics.push(definition);
        }
      }
      
      definition = {
        name: type.name,
        package: packageName,
        methods: type.methods.filter((i) => i.modifiers.length === 0 || i.modifiers.includes("public")).map((method) => {
          let generics: GenericDefinition[] = [];
          if (method.context instanceof GenericInterfaceMethodDeclarationContext) {
            for (const typeParam of method.context.typeParameters().typeParameter()) {
              const paramType = typeParam.typeBound()?.typeType()[0].text;
              const definition: GenericDefinition = {
                name: typeParam.identifier().text,
                superclass: paramType ? {
                  name: tryType(type, paramType),
                } : undefined
              }
              const inner = paramType?.match(/<(.*)>$/);
              if (paramType && inner) {
                definition.superclass = {
                  name: tryType(type, paramType.slice(0, inner.index)),
                  superclass: {
                    name: inner[1].replace('?super', '').replace('?extends', '').replace('@NotNull', ''), // In typescript "extends X" is not required
                  }
                }
              }

              generics.push(definition);
            }
          }
          return {
            name: method.name,
            parameters: method.parameters.map((param) => {
              const paramType = param.context.typeType().text;
              const definition: GenericDefinition = {
                name: param.type.qualifiedName,
              }
              const inner = paramType?.match(/<(.*)>$/);
              if (paramType && inner) {
                const innerInner = inner[1].match(/<(.*)>$/);
                definition.superclass = {
                  name: (innerInner ? inner[1].slice(0, innerInner.index) : inner[1]).replace('?super', '').replace('?extends', '').replace('@NotNull', ''),
                  superclass: innerInner ? {
                    name: innerInner[1].replace('?super', '').replace('?extends', '').replace('@NotNull', ''), // In typescript "extends X" is not required
                  } : undefined,
                }
              }
              

              return {
                name: replaceIllegalParameters(param.name),
                type: definition,
              }}),
            returnType: tryType(type, method.type.qualifiedName),
            generics,
            static: method.modifiers.includes("static"),
          }}),
        type: 'interface',
        interfaces: type.interfaces.map(i => i.canonicalName()),
        generics: interfaceGenerics,
      }
    } else if (type instanceof Class) {
      let classGenerics: GenericDefinition[] = [];
      const typeParams = type.context.typeParameters();
      if (typeParams) {
        for (const typeParam of typeParams.typeParameter()) {
          const paramType = typeParam.typeBound()?.typeType()[0].text;
          const definition: GenericDefinition = {
            name: typeParam.identifier().text,
            superclass: paramType ? {
              name: tryType(type, paramType),
            } : undefined
          }
          const inner = paramType?.match(/<(.*)>$/);
          if (paramType && inner) {
            definition.superclass = {
              name: tryType(type, paramType.slice(0, inner.index)),
              superclass: {
                name: inner[1].replace('?super', '').replace('?extends', '').replace('@NotNull', ''), // In typescript "extends X" is not required
              }
            }
          }

          classGenerics.push(definition);
        }
      }
      definition = {
        name: type.name,
        package: packageName,
        constructors: type.constructors.filter((i) => i.modifiers.includes("public")).map((c) => ({
          parameters: c.parameters.map((param) => {
            const paramType = param.context.typeType().text;
            const definition: GenericDefinition = {
              name: param.type.qualifiedName,
            }
            const inner = paramType?.match(/<(.*)>$/);
            if (paramType && inner) {
              const innerInner = inner[1].match(/<(.*)>$/);
              definition.superclass = {
                name: (innerInner ? inner[1].slice(0, innerInner.index) : inner[1]).replace('?super', '').replace('?extends', '').replace('@NotNull', ''),
                superclass: innerInner ? {
                  name: innerInner[1].replace('?super', '').replace('?extends', '').replace('@NotNull', ''), // In typescript "extends X" is not required
                } : undefined,
              }
            }
            
            return {
              name: replaceIllegalParameters(param.name),
              type: definition,
            }})
        })),
        fields: type.fields.filter((i) => i.modifiers.includes("public")).map((field) => ({ 
          name: field.name,
          type: tryType(type, field.type.qualifiedName),
          readonly: field.modifiers.includes("final"),
          static: field.modifiers.includes("static"),
        })),
        methods: type.methods.filter((i) => i.modifiers.includes("public")).map((method) => {
          let generics: GenericDefinition[] = [];
          if (method.context instanceof GenericInterfaceMethodDeclarationContext) {
            for (const typeParam of method.context.typeParameters().typeParameter()) {
              const paramType = typeParam.typeBound()?.typeType()[0].text;
              const definition: GenericDefinition = {
                name: typeParam.identifier().text,
                superclass: paramType ? {
                  name: tryType(type, paramType),
                } : undefined
              }
              const inner = paramType?.match(/<(.*)>$/);
              if (paramType && inner) {
                definition.superclass = {
                  name: tryType(type, paramType.slice(0, inner.index)),
                  superclass: {
                    name: inner[1].replace('?super', '').replace('?extends', '').replace('@NotNull', ''), // In typescript "extends X" is not required
                  }
                }
              }

              generics.push(definition);
            }
          }
          return {
            name: method.name,
            parameters: method.parameters.map((param) => {
              const paramType = param.context.typeType().text;
              const definition: GenericDefinition = {
                name: param.type.qualifiedName,
              }
              const inner = paramType?.match(/<(.*)>$/);
              if (paramType && inner) {
                const innerInner = inner[1].match(/<(.*)>$/);
                definition.superclass = {
                  name: (innerInner ? inner[1].slice(0, innerInner.index) : inner[1]).replace('?super', '').replace('?extends', '').replace('@NotNull', ''),
                  superclass: innerInner ? {
                    name: innerInner[1].replace('?super', '').replace('?extends', '').replace('@NotNull', ''), // In typescript "extends X" is not required
                  } : undefined,
                }
              }
              

              return {
                name: replaceIllegalParameters(param.name),
                type: definition,
              }}),
            returnType: tryType(type, method.type.qualifiedName),
            generics,
            static: method.modifiers.includes("static"),
          }}),
        type: 'class',
        interfaces: type.interfaces.map(i => i.canonicalName()),
        superclass: type.superclass?.canonicalName(),
        generics: classGenerics,
      }
    }

    if (!definition) return;
    moduleTypes.push(definition);
  });

  return moduleTypes;
}
