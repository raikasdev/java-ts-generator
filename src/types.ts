export interface FieldDefinition {
    name: string;
    type: string;
    readonly: boolean;
    static: boolean;
    javadoc?: string;
}

export interface GenericDefinition {
    name: string;
    superclass?: GenericDefinition;
}

export interface MethodDefinition {
    name: string;
    returnType: string;
    parameters: ParameterDefinition[];
    generics?: GenericDefinition[];
    static: boolean;
    javadoc?: string;
}

export interface ParameterDefinition {
    name: string;
    type: GenericDefinition;
    javadoc?: string;
}

export interface ClassDefinition {
    type: 'class';
    superclass?: string;
    interfaces: string[];
    constructors: ConstructorDefinition[];

    fields: FieldDefinition[];
    generics?: GenericDefinition[];
}

export interface ConstructorDefinition {
    parameters: ParameterDefinition[];
}

export interface InterfaceDefinition {
    type: 'interface';
    interfaces: string[];
    generics?: GenericDefinition[];
}

export type TypeDefinition = {
    package: string;
    name: string;

    methods: MethodDefinition[];

    javadoc?: string;
} & (ClassDefinition | InterfaceDefinition);