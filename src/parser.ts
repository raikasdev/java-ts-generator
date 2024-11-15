import { Class, Enum, Interface, parse, Record, TypeDeclaration } from "../java-model";
import fs from 'fs/promises';
import type { GenericDefinition, TypeDefinition } from "./types";
import { GenericInterfaceMethodDeclarationContext, GenericMethodDeclarationContext, LastFormalParameterContext, MethodDeclarationContext } from "java-ast";

function tryType(type: TypeDeclaration, typeName: string) {
  typeName = typeName.replaceAll('?super', '').replaceAll('?extends', '').replaceAll('@NotNull', '');
  
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
    'Object',
    '?',
  ];
  if (native.includes(typeName) || typeName.split(".").length > 3) {
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

function parseGeneric(type: TypeDeclaration, name: string) {
  let fixed = false;
  const definition: GenericDefinition = {
    name,
  }
  const inner = name.match(/<(.*)>/);
  if (inner) {
    definition.name = tryType(type, definition.name.slice(0, inner.index));
    fixed = true;

    const topLevelGenerics = inner[1].match(/([^,<]+(?:<[^>]+>)?[^,]*)/g);
    if (!topLevelGenerics) return definition;
    
    topLevelGenerics.map((i) => i.trim()).forEach((i) => {
      if (!definition.generics) definition.generics = [];
      definition.generics.push(parseGeneric(type, i));
    });
  }

  if (!fixed) {
    definition.name = tryType(type, definition.name);
  }

  return definition;
}

export async function processJavaSource(files: string[]): Promise<TypeDefinition[]> {
  const JETBRAINS_ANNOTATIONS = ['NotNull', 'Nullable', 'Unmodifiable', 'UnknownNullability'];
  const file = await parse({ files, readAsync: async (file) => {
    let content = await fs.readFile(file, 'utf-8');
    // Remove annotations to easen parsing
    for (const annotation of JETBRAINS_ANNOTATIONS) {
      content = content.replaceAll(`.@org.jetbrains.annotations.${annotation} `, '');
      content = content.replaceAll(`@${annotation} `, '');
      content = content.replaceAll(`@${annotation}...`, '...');
    }
    return content;
  }});
  let packageName = '';
  let moduleTypes: TypeDefinition[] = [];

  file.visitTypes((type) => {
    const packageParts = type.canonicalName().split('.');
    packageParts.pop();
    packageName = packageParts.join(".");

    if (type.name.endsWith('Impl')) return; // Ignore implementations
    if (type.modifiers.includes("private") || type.modifiers.includes("protected")) return;
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
            
            return {
              name: replaceIllegalParameters(param.name),
              type: parseGeneric(type, paramType),
              spread: (param.context instanceof LastFormalParameterContext && !!param.context.ELLIPSIS()),
            }})
          })),
        methods: type.methods.filter((i) => i.modifiers.includes("public")).map((method) => {
          let fullType = method.type.qualifiedName;
          if (method.context instanceof MethodDeclarationContext) {
            fullType = method.context.typeTypeOrVoid().text;
          } else if (method.context instanceof GenericMethodDeclarationContext) {
            fullType = method.context.methodDeclaration().typeTypeOrVoid().text;
          } else {
            fullType = method.context.interfaceCommonBodyDeclaration()!.typeTypeOrVoid().text;
          }

          return {
          name: method.name,
          parameters: method.parameters.map((param) => {
            const paramType = param.context.typeType().text;
            
            return {
              name: replaceIllegalParameters(param.name),
              type: parseGeneric(type, paramType),
              spread: (param.context instanceof LastFormalParameterContext && !!param.context.ELLIPSIS()),
            }}),
          returnType: parseGeneric(type, fullType),
          static: method.modifiers.includes("static"),
        }}),
        type: 'class',
        interfaces: [],
        superclass: { name: 'java.lang.Enum', generics: [{ name: type.name }] },
      }
    } else if (type instanceof Interface) {
      let interfaceGenerics: GenericDefinition[] = [];
      const typeParams = type.context.typeParameters();
      if (typeParams) {
        for (const typeParam of typeParams.typeParameter()) {
          const extendsArr = [];
          for (const paramType of typeParam.typeBound()?.typeType() ?? []) {
            if (!paramType) continue;
            extendsArr.push(parseGeneric(type, paramType.text));
          }
          interfaceGenerics.push({
            name: typeParam.identifier().text,
            extends: extendsArr,
          });
        }
      }
      
      definition = {
        name: type.name,
        package: packageName,
        methods: type.methods.filter((i) => !i.modifiers.includes("private") && !i.modifiers.includes("protected")).map((method) => {
          let generics: GenericDefinition[] = [];
          if (method.context instanceof GenericInterfaceMethodDeclarationContext) {    
            for (const typeParam of method.context.typeParameters().typeParameter()) {       
              const extendsArr = [];
              for (const paramType of typeParam.typeBound()?.typeType() ?? []) {
                if (!paramType) continue;
                extendsArr.push(parseGeneric(type, paramType.text));
              }

              generics.push({
                name: typeParam.identifier().text,
                extends: extendsArr,
              });
            }
          }
          let fullType = method.type.qualifiedName;
          if (method.context instanceof MethodDeclarationContext) {
            fullType = method.context.typeTypeOrVoid().text;
          } else if (method.context instanceof GenericMethodDeclarationContext) {
            fullType = method.context.methodDeclaration().typeTypeOrVoid().text;
          } else {
            fullType = method.context.interfaceCommonBodyDeclaration()!.typeTypeOrVoid().text;
          }
          
          return {
            name: method.name,
            parameters: method.parameters.map((param) => {
              const paramType = param.context.typeType().text;
              
              return {
                name: replaceIllegalParameters(param.name),
                type: parseGeneric(type, paramType),
                spread: (param.context instanceof LastFormalParameterContext && !!param.context.ELLIPSIS()),
              }}),
            returnType: parseGeneric(type, fullType),
            generics,
            static: method.modifiers.includes("static"),
          }}),
        type: 'interface',
        interfaces: type.interfaces.map(i => ({ name: i.canonicalName(), generics: i.arguments.length === 0 ? undefined : i.arguments.map((i) => parseGeneric(type, i.name)) })),
        generics: interfaceGenerics,
      }
    } else if (type instanceof Class) {
      let classGenerics: GenericDefinition[] = [];
      const typeParams = type.context.typeParameters();
      if (typeParams) {
        for (const typeParam of typeParams.typeParameter()) {
          const extendsArr = [];
          for (const paramType of typeParam.typeBound()?.typeType() ?? []) {
            if (!paramType) continue;
            extendsArr.push(parseGeneric(type, paramType.text));
          }
          classGenerics.push({
            name: typeParam.identifier().text,
            extends: extendsArr,
          });
        }
      }
      definition = {
        name: type.name,
        package: packageName,
        constructors: type.constructors.filter((i) => i.modifiers.includes("public")).map((c) => ({
          parameters: c.parameters.map((param) => {
            const paramType = param.context.typeType().text;
            
            return {
              name: replaceIllegalParameters(param.name),
              type: parseGeneric(type, paramType),
              spread: (param.context instanceof LastFormalParameterContext && !!param.context.ELLIPSIS()),
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
          if (method.context instanceof GenericMethodDeclarationContext) {
            for (const typeParam of method.context.typeParameters().typeParameter()) {
              const extendsArr = [];
              for (const paramType of typeParam.typeBound()?.typeType() ?? []) {
                if (!paramType) continue;
                extendsArr.push(parseGeneric(type, paramType.text));
              }
              generics.push({
                name: typeParam.identifier().text,
                extends: extendsArr,
            });
            }
          }
          
          let fullType = method.type.qualifiedName;
          if (method.context instanceof MethodDeclarationContext) {
            fullType = method.context.typeTypeOrVoid().text;
          } else if (method.context instanceof GenericMethodDeclarationContext) {
            fullType = method.context.methodDeclaration().typeTypeOrVoid().text;
          } else {
            fullType = method.context.interfaceCommonBodyDeclaration()!.typeTypeOrVoid().text;
          }

          return {
            name: method.name,
            parameters: method.parameters.map((param) => {
              const paramType = param.context.typeType().text;
              
              return {
                name: replaceIllegalParameters(param.name),
                type: parseGeneric(type, paramType),
                spread: (param.context instanceof LastFormalParameterContext && !!param.context.ELLIPSIS()),
              }}),
            returnType: parseGeneric(type, fullType),
            generics,
            static: method.modifiers.includes("static"),
          }}),
        type: 'class',
        interfaces: type.interfaces.map(i => ({ name: i.canonicalName(), generics: i.arguments.length === 0 ? undefined : i.arguments.map((i) => parseGeneric(type, i.name)) })),
        superclass: type.superclass ? { name: type.superclass.canonicalName(), generics: type.superclass.arguments.length === 0 ? undefined : type.superclass.arguments.map((i) => parseGeneric(type, i.name)) } : undefined,
        generics: classGenerics,
      }
    }

    if (!definition) return;
    moduleTypes.push(definition);
  });

  return moduleTypes;
}
