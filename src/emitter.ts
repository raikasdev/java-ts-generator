import type { TypeDefinition, MethodDefinition, FieldDefinition, ConstructorDefinition, GenericDefinition } from './types';


export class TypeScriptEmitter {
    private priority: string[];
    constructor() {
      this.priority = ['Iterator', 'Date', 'Location'];
    }

    private findInheritedMethods(type: TypeDefinition, packageTypes: TypeDefinition[], existingNames: string[]): MethodDefinition[];
    private findInheritedMethods(type: TypeDefinition, packageTypes: TypeDefinition[], existingNames: string[], grouped: false): MethodDefinition[];
    private findInheritedMethods(type: TypeDefinition, packageTypes: TypeDefinition[], existingNames: string[], grouped: true): Map<string, MethodDefinition[]>;
    private findInheritedMethods(type: TypeDefinition, packageTypes: TypeDefinition[], existingNames: string[], grouped = false): MethodDefinition[] | Map<string, MethodDefinition[]> {
      const methodMap: Map<string, MethodDefinition[]> = new Map();

      if (type.type === 'class' && type.superclass) {
        let methods = methodMap.get(type.name) ?? [];
        const superType = packageTypes.find(t => `${t.package}.${t.name}` === type.superclass!.name);
        if (superType && !existingNames.includes(superType.name)) {
          existingNames.push(superType.name);
          methods.push(...superType.methods);
          methods = methods.concat(this.findInheritedMethods(superType, packageTypes, existingNames)); 
        }
        methodMap.set(type.name, methods);
      }

      type.interfaces.forEach(iface => {
        let methods = methodMap.get(type.name) ?? [];
        const ifaceType = packageTypes.find(t => `${t.package}.${t.name}` === iface.name);
        if (ifaceType && !existingNames.includes(ifaceType.name)) {
          existingNames.push(ifaceType.name);
          methods.push(...ifaceType.methods);
          methods = methods.concat(this.findInheritedMethods(ifaceType, packageTypes, existingNames));
        }
        methodMap.set(type.name, methods);
      });

      if (grouped) {
        return methodMap;
      } else {
        return Array.from(methodMap.values()).flat();
      }
    }

    emitPackage(basePackage: string, packageTypes: TypeDefinition[], allTypes: TypeDefinition[]): string {
      // TypeScriptin object inheritance toimii vähän eritavalla -> saman niminen metodi alaoliossa ylikirjoittaa kaikki ylätason metodit
      for (const type of packageTypes) {
          // Käydään metodit läpi parentilta, jos löydetään samanniminen mutta ei yhtäkään samalla parametrimäärällä kuin childissä niin kopsataan
          for (const method of this.findInheritedMethods(type, allTypes, [])) {
            if (method.name.startsWith('get ') || method.name.startsWith('set ')) {
              continue;
            }
            const found1 = type.methods.find(m => m.name === method.name);
            const found2 = type.methods.find(m => m.name === method.name && JSON.stringify(m.parameters.map((i) => i.type)) === JSON.stringify(method.parameters.map((i) => i.type)) && JSON.stringify(m.generics) === JSON.stringify(method.generics));
            // TODO: check if return type is compatible, if not it needs to be added
            // why does this have to be some complicated

            // If method has a generic value but doesn't provide it themselves (for example T from the class) ignore that
            function extractGeneric(type: GenericDefinition): string[] {
              const generics = [];
              if (type.name.length === 1) {
                generics.push(type.name);
              }
              if (type.generics) {
                for (const generic of type.generics) {
                  generics.push(...extractGeneric(generic));
                }
              }
              return generics;
            }
            if (extractGeneric(method.returnType).filter((i) => !method.generics?.find((j) => j.name === i)).length > 0) {
              continue;
            }
            if (method.parameters.find((p) => extractGeneric(p.type).filter((i) => !method.generics?.find((j) => j.name === i)).length > 0)) {
              continue;
            }
            if (found1 && !found2) {
              type.methods.push(method);
            }
          }
        }
        // Ryhmittele tyypit alipakettien mukaan
        const subPackages = new Map<string, TypeDefinition[]>();
        for (const type of packageTypes) {
            if (!subPackages.has(type.package)) {
                subPackages.set(type.package, []);
            }
            subPackages.get(type.package)!.push(type);
        }

        // Generoi jokainen alipakettimoduuli
        const moduleDefinitions = Array.from(subPackages.entries())
            .map(([packageName, types]) => this.emitModule(packageName, types, allTypes))
            .join('\n\n');

        return moduleDefinitions;
    }

    private emitModule(packageName: string, moduleTypes: TypeDefinition[], allTypes: TypeDefinition[]): string {
        const { imports, renamed } = this.generateImports(moduleTypes, packageName);
        const typeDefinitions = moduleTypes
            .sort((a, b) => this.priority.indexOf(b.name) - this.priority.indexOf(a.name))
            .map(type => this.emitType(type, renamed, allTypes))
            .join('\n\n');

        return `declare module '${packageName}' {
${imports}${typeDefinitions}
}`;
    }

    private generateImports(moduleTypes: TypeDefinition[], currentPackage: string): { imports: string, renamed: Map<string, string> } {
        const imports = new Map<string, Set<string>>();
        const renamed = new Map<string, string>();
        const existingNames: Map<string, string> = new Map();
        function addImport(qualifiedName: string) {
          if (qualifiedName === '?') return; // any

          const parts = qualifiedName.split('.');
          let className = parts.pop();
          const packageName = parts.join('.');
          if (packageName === '') return; // native types
          if (packageName === currentPackage) {
            return; // same package
          }
          if (!className) return;

          if (className.endsWith("[]")) {
            className = className.slice(0, -2);
          }

          const inner = className.match(/<(.*)>/);
          if (inner) {
            className = className.slice(0, inner.index);
          }

          if ((existingNames.has(className) && existingNames.get(className) !== packageName) || moduleTypes.find((i) => i.package === currentPackage && i.name === className)) {
            renamed.set(qualifiedName, `${packageName.toLowerCase().replaceAll('.', '_')}_${className}`);
            className = `${className} as ${packageName.toLowerCase().replaceAll('.', '_')}_${className}`;
          }

          existingNames.set(className, packageName);

          const arr = imports.get(packageName) || new Set();
          arr.add(className);
          imports.set(packageName, arr);
        }

        function superClassIterate(superclass: GenericDefinition[]) {
          for (const s of superclass) {
            addImport(s.name);
            if (s.generics) {
              superClassIterate(s.generics);
            }
            if (s.extends) {
              superClassIterate(s.extends);
            }
          }
        }

        for (const type of moduleTypes) {
          // Debugging is fun!
          if (Bun.env.JAVA_TS_DEBUG === "1") {
            Bun.write('./output/' + `${type.package}.${type.name}`.replaceAll('.', '_') + '.json', JSON.stringify(type, null, 2));
          }
          if ('superclass' in type && type.superclass) {
            superClassIterate([type.superclass]);
          }
          if ('interfaces' in type) {
            for (const iface of type.interfaces) {
              addImport(iface.name);
              if (iface.generics) {
                superClassIterate(iface.generics);
              }
            }
          }
          if ('fields' in type && type.fields.length > 0) {
            for (const field of type.fields) {
              addImport(field.type);
            }
          }
          if ('constructors' in type && type.constructors.length > 0) {
            for (const method of type.constructors) {
              for (const param of method.parameters) {
                addImport(param.type.name);
                if (param.type.generics) {
                  superClassIterate(param.type.generics);
                }
              }
            }
          }
          if ('methods' in type && type.methods.length > 0) {
            for (const method of type.methods) {
              addImport(method.returnType.name);
              if (method.returnType.generics) {
                superClassIterate(method.returnType.generics);
              }
              for (const param of method.parameters) {
                addImport(param.type.name);
                if (param.type.generics) {
                  superClassIterate(param.type.generics);
                }
              }

              if ('generics' in method && method.generics && method.generics.length > 0) {
                superClassIterate(method.generics);
              }
            }
          }
          if ('generics' in type && type.generics && type.generics.length > 0) {
            for (const generic of type.generics) {
              if (generic.generics) {
                superClassIterate(generic.generics);
              }
            }
          }
        }

        const importDeclarations: string[] = [];
        for (const [packageName, classNameSet] of imports.entries()) {
          importDeclarations.push(`import { ${Array.from(classNameSet).join(', ')} } from '${packageName}';`);
        }

        return { imports: importDeclarations.length > 0 ? `  ${importDeclarations.join('\n  ')}\n\n` : '', renamed };
    }

    private emitType(type: TypeDefinition, renamed: Map<string, string>, allTypes: TypeDefinition[]): string {
        let result = '';
        
        // Lisää javadoc jos on
        if (type.javadoc) {
            result += `  /**\n   * ${type.javadoc}\n   */\n`;
        }

        // Aloita tyyppi määrittely
        let extendsList: GenericDefinition[] = [];
        if (type.interfaces) {
          extendsList = type.interfaces;
        }
        if ('superclass' in type && type.superclass) {
          extendsList.push(type.superclass);
        }

        if (extendsList.length > 0) {
          result += `  interface ${type.name}`; // TypeScript implements is ass
          if (type.generics && type.generics.length > 0) {
            result += `<${type.generics.map((g) => this.convertGenericType(g, renamed, 'any')).join(", ")}>`;
          }
          result += ` extends ${extendsList.map((i) => this.convertGenericType(i, renamed, null, true)).join(", ")} {}\n`;
        }

        result += `  class ${type.name}`;
        if (type.generics && type.generics.length > 0) {
          result += `<${type.generics.map((g) => this.convertGenericType(g, renamed, 'any')).join(", ")}>`;
        }
        if (extendsList.length > 0) {
          const superClass = extendsList[0];
          result += ` extends ${this.convertGenericType(superClass, renamed, null, true)}`; // TypeScript implements is ass
        }
        result += ' {\n';

        if (type.package === 'java.lang' && type.name === 'Iterable') {
          result += `    [Symbol.iterator](): globalThis.Iterator<${(type.generics ?? [])[0]?.name ?? 'T'}>;\n`
        }

        // Lisää kentät ja metodit
        if ('fields' in type && type.fields.length > 0) {
            result += this.emitFields(type.fields, renamed);
        }

        // Emit constructors
        if ('constructors' in type && type.constructors.length > 0) {
          result += this.emitConstructors(type.constructors, renamed);
        }

        // Käydään läpi niitä classeja ja inheritancea...
        const inheritedMethods = this.findInheritedMethods(type, allTypes, []);

        // If both getX and setX exists, add getter and setter functions and set javadocs of original to @deprecated
        // This is CraftJS specific functionality: if you are forking this for something else feel free to remove this section
        for (const getter of type.methods.filter((i) => i.name.startsWith("get") && i.parameters.length === 0 && (type.type !== 'interface' || !i.static))) {
          let valueName = getter.name.slice(3); // And set first letter to lowercase
          valueName = valueName.charAt(0).toLowerCase() + valueName.slice(1);
          if (type.methods.find((i) => i.name === valueName && !i.static) || inheritedMethods.find((i) => i.name === valueName && !i.static)) {
            continue;
          }
          getter.javadoc = `@deprecated Use get/set`;
          type.methods.push({
            name: `get ${valueName}`,
            parameters: [],
            returnType: getter.returnType,
            static: getter.static,
            generics: getter.generics,
          });
          const setter = type.methods.find((i) => i.name === `set${getter.name.slice(3)}` && i.parameters.length === 1);
          if (setter) {
            setter.javadoc = `@deprecated Use get/set`;

            type.methods.push({
              name: `set ${valueName}`,
              parameters: setter.parameters,
              returnType: { name: 'void', nullable: false },
              static: setter.static,
              generics: setter.generics,
            });
          }
        }

        type.methods = type.methods.filter((i) => i.javadoc !== `@deprecated Use get/set`);
        type.methods = type.methods.filter((i) => !(i.name === 'name' && i.parameters.length === 0)); // Fuck the name(): Component

        type.methods = type.methods.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
        if (type.methods.length > 0) {
            result += this.emitMethods(type.methods, renamed);
        }

        result += '  }\n';
        return result;
    }

    private emitConstructors(constructors: ConstructorDefinition[], renamed: Map<string, string>): string {
      return constructors.map(constructor => {
        return `    constructor(${constructor.parameters.map(p => `${p.spread ? '...' : ''}${p.name}: ${this.convertGenericType(p.type, renamed)}${p.spread ? '[]' : ''}`).join(', ')});\n`;
      }).join('\n');
    }

    private emitFields(fields: FieldDefinition[], renamed: Map<string, string>): string {
        return fields.map(field => {
            let result = '';
            if (field.javadoc) {
                result += `    /**\n     * ${field.javadoc}\n     */\n`;
            }
            result += `    `;
            if (field.static) {
              result += 'static ';
            }
            if (field.readonly) {
              result += 'readonly ';
            }
            result += `${field.name}: ${this.convertType(field.type, renamed)};`;
            return result;
        }).join('\n') + '\n';
    }

    private emitMethods(methods: MethodDefinition[], renamed: Map<string, string>): string {
        return methods.map(method => {
            let result = '';
            if (method.javadoc) {
                result += `    /**\n     * ${method.javadoc}\n     */\n`;
            }
            const params = method.parameters.map(p => 
                `${p.spread ? '...' : ''}${p.name}: ${this.convertGenericType(p.type, renamed)}${p.spread ? '[]' : ''}${p.nullable ? ' | null' : ''}`
            ).join(', ');
            const generics = (method.generics && method.generics.length > 0) ? 
              `<${method.generics.map(g => this.convertGenericType(g, renamed)).join(', ')}>` : '';
            result += `    `;
            if (method.static) {
              result += 'static ';
            }
            result += `${method.name}${generics}(${params})`;
            if (!method.name.startsWith('set ')) {
              result += `: ${this.convertGenericType(method.returnType, renamed)}${method.returnType.nullable ? ' | null' : ''}`;
            }
            result += `;`;
            return result;
        }).join('\n') + '\n';
    }

    private getTypeModule(fullName: string): string {
        const parts = fullName.split('.');
        return parts.slice(0, -1).join('.');
    }

    private getTypeName(fullName: string, renamed: Map<string, string>): string {
        return (renamed.get(fullName) || (fullName.split('.').pop() || fullName)).replaceAll('?','any');
    }

    private convertGenericType(type: GenericDefinition, renamed: Map<string, string>, defaultValue: string | null = null, keepList = false): string {
      let val = `${this.convertType(type.name, renamed)}${type.generics ? `<${type.generics.map(t => this.convertGenericType(t, renamed)).join(', ')}>` : ''}`;
      if ((type.name === 'List' || type.name === 'java.util.List') && type.generics && !keepList) {
        val= `${this.convertGenericType(type.generics[0], renamed)}[]`;
      }
      if (type.extends && type.extends.length > 0) {
        val += ` extends ${type.extends.map(t => this.convertGenericType(t, renamed)).join(' & ')}`;
      }
      if (defaultValue) {
        val += ` = ${defaultValue}`;
      }
      return val;
    }

    private convertType(javaType: string, renamed: Map<string, string>): string {
        // Yksinkertainen Java -> TypeScript tyyppimuunnos
        const typeMap: { [key: string]: string } = {
          'void': 'void',
          'boolean': 'boolean',
          'byte': 'number',
          'short': 'number',
          'int': 'number',
          'long': 'number',
          'float': 'number',
          'double': 'number',
          'char': 'string',
          'String': 'string',
          'Object': 'any',
          '?': 'any',
          'java.lang.String': 'string',
          'java.lang.Integer': 'number',
          'java.lang.Boolean': 'boolean',
          'java.lang.Byte': 'number',
          'java.lang.Short': 'number',
          'java.lang.Character': 'string',
          'java.lang.Float': 'number',
          'java.lang.Double': 'number',
          'java.lang.Object': 'any',
        };

        // Tarkista array-tyypit
        if (javaType.endsWith('[]')) {
          const baseType = javaType.slice(0, -2);
          return `${this.convertType(baseType, renamed)}[]`;
        }

        const inner = javaType.match(/<(.*)>/);
        if (inner) {
          const baseType = javaType.slice(0, inner.index);
          if (baseType === 'List' || baseType === 'java.util.List') {
            return `${this.convertType(inner[1], renamed)}[]`;
          }
          return `${this.convertType(baseType, renamed)}<${this.convertType(inner[1], renamed)}>`;
        }

        return typeMap[javaType] || this.getTypeName(javaType, renamed);
    }
}