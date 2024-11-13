import { findObject, qualifiedName, splitName } from "./common";
import {
  CompilationUnit,
  TypeDeclaration,
  TypeContainer,
  Project,
  ResolvedType,
} from "./Project";
import { TypeReference } from "./TypeReference";

export function resolve(
  project: Project,
  container: TypeContainer,
  name: string
): ResolvedType {
  if (name.includes(".")) {
    const { qualifier, name: simpleName } = splitName(name);
    const qualifierType = resolve(project, container, qualifier!);
    if (qualifierType instanceof TypeDeclaration) {
      const type = findObject(qualifierType.types, simpleName);
      if (type != undefined) {
        return type;
      }
    } else if (qualifierType instanceof TypeReference) {
      return new TypeReference(`${qualifierType.name}.${simpleName}`);
    }
    throw new ResolveError(container, name);
  }

  if (container instanceof TypeDeclaration) {
    const typeParam = container.findObject((parent) =>
      parent instanceof TypeDeclaration
        ? findObject(parent.parameters, name)
        : undefined
    );
    if (typeParam != undefined) {
      return typeParam;
    }

    const declaredType = container.findObject((parent) =>
      parent.name === name ? parent : findObject(parent.types, name)
    );
    if (declaredType != undefined) {
      return declaredType;
    }
  }

  const compilationUnit =
    container instanceof CompilationUnit
      ? container
      : container.compilationUnit();

  const importName = compilationUnit.findImport(name);
  if (importName != undefined) {
    const resolved = project.findType(importName);
    return resolved ?? new TypeReference(importName);
  }

  const { packageName } = compilationUnit;
  if (packageName != undefined) {
    for (const compilationUnit of project.findCompilationUnits(packageName)) {
      const samePackageType = findObject(compilationUnit.types, name);
      if (samePackageType != undefined) {
        return samePackageType;
      }
    }
  }

  if (JAVA_LANG_TYPES.includes(name)) {
    return new TypeReference(`java.lang.${name}`);
  }

  const starImports = compilationUnit.imports.filter((i) => i.endsWith(".*"));
  if (starImports.length === 0) {
    return new TypeReference(qualifiedName(packageName, name));
  } else if (starImports.length === 1) {
    return new TypeReference(`${starImports[0].slice(0, -1)}${name}`);
  } else {
    throw new ResolveError(container, name);
  }
}

export class ResolveError extends Error {
  readonly context: TypeContainer;
  readonly typeName: string;

  constructor(context: TypeContainer, typeName: string) {
    super(`cannot resolve type: ${typeName}`);
    this.context = context;
    this.typeName = typeName;
  }
}

const JAVA_LANG_TYPES = [
  "Appendable",
  "AutoCloseable",
  "CharSequence",
  "Cloneable",
  "Comparable",
  "Iterable",
  "Readable",
  "Runnable",
  "Thread.UncaughtExceptionHandler",
  "Boolean",
  "Byte",
  "Character",
  "Character.Subset",
  "Character.UnicodeBlock",
  "Class",
  "ClassLoader",
  "ClassValue",
  "Compiler",
  "Double",
  "Enum",
  "Enum",
  "Float",
  "InheritableThreadLocal",
  "Integer",
  "Long",
  "Math",
  "Number",
  "Object",
  "Package",
  "Process",
  "ProcessBuilder",
  "ProcessBuilder.Redirect",
  "Runtime",
  "RuntimePermission",
  "SecurityManager",
  "Short",
  "StackTraceElement",
  "StrictMath",
  "String",
  "StringBuffer",
  "StringBuilder",
  "System",
  "Thread",
  "ThreadGroup",
  "ThreadLocal",
  "Throwable",
  "Void",
  "Character.UnicodeScript",
  "ProcessBuilder.Redirect.Type",
  "Thread.State",
  "ArithmeticException",
  "ArrayIndexOutOfBoundsException",
  "ArrayStoreException",
  "ClassCastException",
  "ClassNotFoundException",
  "CloneNotSupportedException",
  "EnumConstantNotPresentException",
  "Exception",
  "IllegalAccessException",
  "IllegalArgumentException",
  "IllegalMonitorStateException",
  "IllegalStateException",
  "IllegalThreadStateException",
  "IndexOutOfBoundsException",
  "InstantiationException",
  "InterruptedException",
  "NegativeArraySizeException",
  "NoSuchFieldException",
  "NoSuchMethodException",
  "NullPointerException",
  "NumberFormatException",
  "ReflectiveOperationException",
  "RuntimeException",
  "SecurityException",
  "StringIndexOutOfBoundsException",
  "TypeNotPresentException",
  "UnsupportedOperationException",
  "AbstractMethodError",
  "AssertionError",
  "BootstrapMethodError",
  "ClassCircularityError",
  "ClassFormatError",
  "Error",
  "ExceptionInInitializerError",
  "IllegalAccessError",
  "IncompatibleClassChangeError",
  "InstantiationError",
  "InternalError",
  "LinkageError",
  "NoClassDefFoundError",
  "NoSuchFieldError",
  "NoSuchMethodError",
  "OutOfMemoryError",
  "StackOverflowError",
  "ThreadDeath",
  "UnknownError",
  "UnsatisfiedLinkError",
  "UnsupportedClassVersionError",
  "VerifyError",
  "VirtualMachineError",
  "Deprecated",
  "Override",
  "SafeVarargs",
  "SuppressWarnings"
];