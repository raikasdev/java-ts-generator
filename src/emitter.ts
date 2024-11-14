import type { TypeDefinition, MethodDefinition, FieldDefinition, ConstructorDefinition, GenericDefinition } from './types';

export class TypeScriptEmitter {
    private types: Map<string, TypeDefinition>;
    constructor(types: Map<string, TypeDefinition>) {
        this.types = types;
    }

    private findInheritedMethods(type: TypeDefinition, packageTypes: TypeDefinition[], existingNames: string[]) {
      let methods: MethodDefinition[] = [];

      if (type.type === 'class' && type.superclass) {
        const superType = packageTypes.find(t => `${t.package}.${t.name}` === type.superclass!.name);
        if (superType && !existingNames.includes(superType.name)) {
          existingNames.push(superType.name);
          methods.push(...superType.methods);
          methods = methods.concat(this.findInheritedMethods(superType, packageTypes, existingNames)); 
        }
      }

      type.interfaces.forEach(iface => {
        const ifaceType = packageTypes.find(t => `${t.package}.${t.name}` === iface.name);
        if (ifaceType && !existingNames.includes(ifaceType.name)) {
          existingNames.push(ifaceType.name);
          methods.push(...ifaceType.methods);
          methods = methods.concat(this.findInheritedMethods(ifaceType, packageTypes, existingNames));
        }
      });

      return methods;
    }

    emitPackage(basePackage: string, packageTypes: TypeDefinition[], allTypes: TypeDefinition[]): string {
      // TypeScriptin object inheritance toimii vähän eritavalla -> saman niminen metodi alaoliossa ylikirjoittaa kaikki ylätason metodit
      for (const type of packageTypes) {
          // Käydään metodit läpi parentilta, jos löydetään samanniminen mutta ei yhtäkään samalla parametrimäärällä kuin childissä niin kopsataan
          for (const method of this.findInheritedMethods(type, allTypes, [])) {
            const found1 = type.methods.find(m => m.name === method.name);
            const found2 = type.methods.find(m => m.name === method.name && JSON.stringify(m.parameters.map((i) => i.type)) === JSON.stringify(method.parameters.map((i) => i.type)));
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
            .map(([packageName, types]) => this.emitModule(packageName, types))
            .join('\n\n');

        return moduleDefinitions;
    }

    private emitModule(packageName: string, moduleTypes: TypeDefinition[]): string {
        const { imports, renamed } = this.generateImports(moduleTypes, packageName);
        const typeDefinitions = moduleTypes
            .map(type => this.emitType(type, renamed))
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
          if (packageName === currentPackage) return; // same package
          if (!className) return;

          if (className.endsWith("[]")) {
            className = className.slice(0, -2);
          }

          const inner = className.match(/<(.*)>/);
          if (inner) {
            className = className.slice(0, inner.index);
          }

          if (className === 'Iterable' || className === 'java.util.Iterable') return; // Use TypeScript's Iterable instead

          if (existingNames.has(className) && existingNames.get(className) !== packageName) {
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
          }
        }

        for (const type of moduleTypes) {
          // Debugging is fun!
          // Bun.write('./output/' + `${type.package}.${type.name}`.replaceAll('.', '_') + '.json', JSON.stringify(type, null, 2));
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
                for (const generic of method.generics) {
                  if (generic.generics) {
                    superClassIterate(generic.generics);
                  }
                }
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

    private emitType(type: TypeDefinition, renamed: Map<string, string>): string {
        let result = '';
        
        // Lisää javadoc jos on
        if (type.javadoc) {
            result += `  /**\n   * ${type.javadoc}\n   */\n`;
        }

        // Aloita tyyppi määrittely
        switch (type.type) {
            case 'class':
                result += `  class ${type.name}`;
                if (type.generics && type.generics.length > 0) {
                  result += `<${type.generics.map((g) => this.convertGenericType(g, renamed, 'any')).join(", ")}>`;
                }
                if (type.superclass) {
                    result += ` extends ${this.convertGenericType(type.superclass, renamed)}`;
                }
                if (type.interfaces.length > 0) {
                    result += ` implements ${type.interfaces.map(i => `${this.convertGenericType(i, renamed)}`).join(', ')}`;
                }
                break;
            case 'interface':
                result += `  interface ${type.name}`;
                if (type.generics && type.generics.length > 0) {
                    result += `<${type.generics.map((g) => this.convertGenericType(g, renamed, 'any')).join(", ")}>`;
                }
                if (type.interfaces.length > 0) {
                    result += ` extends ${type.interfaces.map(i => this.convertGenericType(i, renamed)).join(', ')}`;
                }
                result += ' {};\n';
                result += `  class ${type.name}`;
                if (type.generics && type.generics.length > 0) {
                    result += `<${type.generics.map((g) => this.convertGenericType(g, renamed, 'any')).join(", ")}>`;
                }
                if (type.interfaces.length > 0) {
                  const nInterfaces = type.interfaces.slice(0, 1);
                  result += ` extends ${nInterfaces.map(i => `${this.convertGenericType(i, renamed)}`).join(', ')}`;
                }
                break;
        }

        result += ' {\n';

        // Lisää kentät ja metodit
        if ('fields' in type && type.fields.length > 0) {
            result += this.emitFields(type.fields, renamed);
        }

        // Emit constructors
        if ('constructors' in type && type.constructors.length > 0) {
          result += this.emitConstructors(type.constructors, renamed);
        }

        // If both getX and setX exists, add getter and setter functions and set javadocs of original to @deprecated
        // This is CraftJS specific functionality: if you are forking this for something else feel free to remove this section
        for (const getter of type.methods.filter((i) => i.name.startsWith("get") && i.parameters.length === 0 && (type.type !== 'interface' || !i.static))) {
          let valueName = getter.name.slice(3); // And set first letter to lowercase
          valueName = valueName.charAt(0).toLowerCase() + valueName.slice(1);
          getter.javadoc = `@deprecated Use ${valueName} instead.`;
          type.methods.push({
            name: `get ${valueName}`,
            parameters: [],
            returnType: getter.returnType,
            static: getter.static,
            generics: getter.generics,
          });
          const setter = type.methods.find((i) => i.name === `set${getter.name.slice(3)}` && i.parameters.length === 1);
          if (setter) {
            setter.javadoc = `@deprecated Use ${valueName} instead.`;

            type.methods.push({
              name: `set ${valueName}`,
              parameters: setter.parameters,
              returnType: { name: 'void' },
              static: setter.static,
              generics: setter.generics,
            });
          }
        }

        if (type.methods.length > 0) {
            result += this.emitMethods(type.methods, renamed);
        }

        result += '  }\n';
        return result;
    }

    private emitConstructors(constructors: ConstructorDefinition[], renamed: Map<string, string>): string {
      return constructors.map(constructor => {
        return `  constructor(${constructor.parameters.map(p => `${p.name}: ${this.convertGenericType(p.type, renamed)}`).join(', ')});\n`;
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
                `${p.name}: ${this.convertGenericType(p.type, renamed)}`
            ).join(', ');
            const generics = (method.generics && method.generics.length > 0) ? 
              `<${method.generics.map(g => this.convertGenericType(g, renamed)).join(', ')}>` : '';
            result += `    `;
            if (method.static) {
              result += 'static ';
            }
            result += `${method.name}${generics}(${params}): ${this.convertGenericType(method.returnType, renamed)};`;
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

    private convertGenericType(type: GenericDefinition, renamed: Map<string, string>, defaultValue: string | null = null): string {
      let val = `${this.convertType(type.name, renamed)}${type.generics ? 
        `<${type.generics.map(t => this.getTypeName(t.name, renamed) + 
        (t.generics ? ('<' + t.generics.map(s => this.getTypeName(s.name, renamed)).join(', ') + '>') : '')).join(', ')}>` : ''}`;
      if ((type.name === 'List' || type.name === 'java.util.List') && type.generics) {
        val= `${this.convertGenericType(type.generics[0], renamed)}[]`;
      }
      if (type.extends && type.extends.length > 0) {
        val += ` extends ${type.extends.map(t => this.convertGenericType(t, renamed)).join(', ')}`;
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
          '?': 'any'
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