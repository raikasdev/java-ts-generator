import type { TypeDefinition, MethodDefinition, FieldDefinition } from './types';

export class TypeScriptEmitter {
    private types: Map<string, TypeDefinition>;
    constructor(types: Map<string, TypeDefinition>) {
        this.types = types;
    }

    emitPackage(basePackage: string, packageTypes: TypeDefinition[]): string {
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
        const existingNames: string[] = [];
        function addImport(qualifiedName: string) {
          const parts = qualifiedName.split('.');
          let className = parts.pop();
          const packageName = parts.join('.');
          if (packageName === '') return; // native types
          if (packageName === currentPackage) return; // same package
          if (!className) return;

          if (className.endsWith("[]")) {
            className = className.slice(0, -2);
          }

          const inner = className.match(/<(.*)>$/);
          if (inner) {
            className = className.slice(0, inner.index);
          }

          if (existingNames.includes(className)) {
            renamed.set(qualifiedName, `${packageName.toLowerCase().replaceAll('.', '_')}_${className}`);
            className = `${className} as ${packageName.toLowerCase().replaceAll('.', '_')}_${className}`;
            console.log('renamed to', className)
          }

          existingNames.push(className);

          const arr = imports.get(packageName) || new Set();
          arr.add(className);
          imports.set(packageName, arr);
        }

        for (const type of moduleTypes) {
          if ('superclass' in type && type.superclass) {
            addImport(type.superclass);
          }
          if ('interfaces' in type) {
            for (const iface of type.interfaces) {
              addImport(iface);
            }
          }
          if ('fields' in type && type.fields.length > 0) {
            for (const field of type.fields) {
              addImport(field.type);
            }
          }
          if ('methods' in type && type.methods.length > 0) {
            for (const method of type.methods) {
              addImport(method.returnType);
              for (const param of method.parameters) {
                addImport(param.type.name);
                if (param.type.superclass) {
                  addImport(param.type.superclass.name);
                  if (param.type.superclass.superclass) {
                    addImport(param.type.superclass.superclass.name);
                  }
                }
              }

              if ('generics' in method && method.generics && method.generics.length > 0) {
                for (const generic of method.generics) {
                  if (generic.superclass) {
                    addImport(generic.superclass.name);
                    if (generic.superclass.superclass) {
                      addImport(generic.superclass.superclass.name);
                    }
                  }
                }
              }
            }
          }
          if ('generics' in type && type.generics && type.generics.length > 0) {
            for (const generic of type.generics) {
              if (generic.superclass) {
                addImport(generic.superclass.name);
                if (generic.superclass.superclass) {
                  addImport(generic.superclass.superclass.name);
                }
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
                    result += `<${type.generics.map(g => `${g.name}${g.superclass ? ` extends ${this.getTypeName(g.superclass.name, renamed)}${g.superclass?.superclass ? ('<' + this.getTypeName(g.superclass.superclass.name, renamed) + '>') : ''}` : ''} = any`).join(', ')}>`;
                }
                if (type.superclass) {
                    result += ` extends ${this.getTypeName(type.superclass, renamed)}`;
                }
                if (type.interfaces.length > 0) {
                    result += ` implements ${type.interfaces.map(i => this.getTypeName(i, renamed)).join(', ')}`;
                }
                break;
            case 'interface':
                result += `  interface ${type.name}`;
                if (type.generics && type.generics.length > 0) {
                    result += `<${type.generics.map(g => `${g.name}${g.superclass ? ` extends ${this.getTypeName(g.superclass.name, renamed)}${g.superclass?.superclass ? ('<' + this.getTypeName(g.superclass.superclass.name, renamed) + '>') : ''}` : ''} = any`).join(', ')}>`;
                }
                if (type.interfaces.length > 0) {
                    result += ` extends ${type.interfaces.map(i => this.getTypeName(i, renamed)).join(', ')}`;
                }
                break;
        }

        result += ' {\n';

        // Lisää kentät ja metodit
        if ('fields' in type && type.fields.length > 0) {
            result += this.emitFields(type.fields, renamed);
        }

        // If both getX and setX exists, add getter and setter functions and set javadocs of original to @deprecated
        for (const getter of type.methods.filter((i) => i.name.startsWith("get"))) {
          let valueName = getter.name.slice(3); // And set first letter to lowercase
          const setter = type.methods.find((i) => i.name === `set${valueName}` && i.parameters.length === 1);
          if (setter) {
            valueName = valueName.charAt(0).toLowerCase() + valueName.slice(1);
            getter.javadoc = `@deprecated Use ${valueName} instead.`;
            setter.javadoc = `@deprecated Use ${valueName} instead.`;

            type.methods.push({
              name: `get ${valueName}`,
              parameters: [],
              returnType: getter.returnType,
              javadoc: `Returns the ${valueName} value.`,
              static: getter.static,
              generics: getter.generics,
            });

            type.methods.push({
              name: `set ${valueName}`,
              parameters: setter.parameters,
              returnType: 'void',
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
            if (method.parameters[0] === undefined) {
              console.log(method);
            }
            const params = method.parameters.map(p => 
                `${p.name}: ${this.convertType(p.type.name, renamed)}${p.type.superclass ? `<${this.getTypeName(p.type.superclass.name, renamed)}${p.type.superclass?.superclass ? ('<' + this.getTypeName(p.type.superclass.superclass.name, renamed) + '>') : ''}>` : ''}`
            ).join(', ');
            const generics = (method.generics && method.generics.length > 0) ? `<${method.generics.map(g => `${g.name}${g.superclass ? ` extends ${this.getTypeName(g.superclass.name, renamed)}${g.superclass?.superclass ? ('<' + this.getTypeName(g.superclass.superclass.name, renamed) + '>') : ''}` : ''}`).join(', ')}>` : '';
            result += `    `;
            if (method.static) {
              result += 'static ';
            }
            result += `${method.name}${generics}(${params}): ${this.convertType(method.returnType, renamed)};`;
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
          'Object': 'any'
        };

        // Tarkista array-tyypit
        if (javaType.endsWith('[]')) {
            const baseType = javaType.slice(0, -2);
            return `${this.convertType(baseType, renamed)}[]`;
        }

        const inner = javaType.match(/<(.*)>$/);
        if (inner) {
          const baseType = javaType.slice(0, inner.index);
          return `${this.convertType(baseType, renamed)}<${inner[1]}>`;
        }

        return typeMap[javaType] || this.getTypeName(javaType, renamed);
    }
}