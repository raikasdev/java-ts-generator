export interface FieldDefinition {
    name: string;
    type: string;
    readonly: boolean;
    static: boolean;
    javadoc?: string;
}

export interface GenericDefinition {
    name: string;
    generics?: GenericDefinition[];
    extends?: GenericDefinition[];
    nullable: boolean;
}

export interface MethodDefinition {
    name: string;
    returnType: GenericDefinition;
    parameters: ParameterDefinition[];
    generics?: GenericDefinition[];
    static: boolean;
    javadoc?: string;
}

export interface ParameterDefinition {
    name: string;
    type: GenericDefinition;
    spread: boolean;
    nullable: boolean;
    javadoc?: string;
}

export interface ClassDefinition {
    type: 'class';
    superclass?: GenericDefinition;
    interfaces: GenericDefinition[];
    constructors: ConstructorDefinition[];

    fields: FieldDefinition[];
    generics?: GenericDefinition[];
}

export interface ConstructorDefinition {
    parameters: ParameterDefinition[];
}

export interface InterfaceDefinition {
    type: 'interface';
    interfaces: GenericDefinition[];
    generics?: GenericDefinition[];
    fields: FieldDefinition[];
}

export type TypeDefinition = {
    package: string;
    name: string;

    methods: MethodDefinition[];

    javadoc?: string;
} & (ClassDefinition | InterfaceDefinition);