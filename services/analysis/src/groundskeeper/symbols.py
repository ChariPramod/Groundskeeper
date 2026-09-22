"""Extract code declarations without importing or executing repository code."""

import hashlib
from pathlib import PurePosixPath

import tree_sitter_python
import tree_sitter_typescript
from tree_sitter import Language, Node, Parser

from groundskeeper.models import SourceFile, Symbol

LANGUAGES = {
    ".py": ("python", Language(tree_sitter_python.language())),
    ".ts": ("typescript", Language(tree_sitter_typescript.language_typescript())),
    ".tsx": ("typescript", Language(tree_sitter_typescript.language_tsx())),
}
DECLARATIONS = {
    "function_definition": "function",
    "function_declaration": "function",
    "generator_function_declaration": "function",
    "class_definition": "class",
    "class_declaration": "class",
    "method_definition": "method",
    "interface_declaration": "interface",
    "type_alias_declaration": "type",
    "enum_declaration": "enum",
    "variable_declarator": "variable",
    "assignment": "variable",
}


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def text(node: Node) -> str:
    return node.text.decode("utf8") if node.text else ""


def semantic_text(node: Node) -> str:
    """Ignore whitespace/comments, preserving literals and token boundaries."""
    if node.type == "comment":
        return ""
    if not node.children or node.type in ("string", "template_string", "string_literal"):
        return f"{node.type}:{text(node)}"
    return "\0".join(filter(None, (semantic_text(child) for child in node.children)))


def extract_symbols(source: SourceFile) -> list[Symbol]:
    entry = LANGUAGES.get(PurePosixPath(source.path).suffix)
    if entry is None:
        return []
    language, grammar = entry
    tree = Parser(grammar).parse(source.content.encode())
    if tree.root_node.has_error:
        raise ValueError(f"Cannot reliably index invalid {language} syntax in {source.path}")
    result: list[Symbol] = []
    occurrences: dict[str, int] = {}

    def walk(node: Node, scope: tuple[str, ...] = ()):
        kind = DECLARATIONS.get(node.type)
        name_node = node.child_by_field_name("left" if node.type == "assignment" else "name")
        next_scope = scope
        if (
            kind
            and name_node
            and name_node.type in ("identifier", "property_identifier", "type_identifier")
        ):
            name = text(name_node)
            qualified_name = ".".join((*scope, name))
            key = f"{source.path}\0{kind}\0{qualified_name}"
            occurrence = occurrences.get(key, 0)
            occurrences[key] = occurrence + 1
            # Python decorators affect a callable's public behavior too.
            content_node = (
                node.parent
                if node.parent and node.parent.type in ("decorated_definition", "export_statement")
                else node
            )
            result.append(
                Symbol(
                    id=digest(f"{key}\0{occurrence}"),
                    path=source.path,
                    name=name,
                    qualified_name=qualified_name,
                    kind=kind,
                    language=language,
                    start_line=node.start_point.row + 1,
                    end_line=node.end_point.row + 1,
                    fingerprint=digest(semantic_text(content_node)),
                )
            )
            next_scope = (*scope, name)
        for child in node.named_children:
            walk(child, next_scope)

    walk(tree.root_node)
    # A file symbol lets relative path references detect deletion/moves and non-declaration changes.
    result.append(
        Symbol(
            id=digest(f"file\0{source.path}"),
            path=source.path,
            name=source.path,
            qualified_name=source.path,
            kind="file",
            language=language,
            start_line=1,
            end_line=tree.root_node.end_point.row + 1,
            fingerprint=digest(semantic_text(tree.root_node)),
        )
    )
    return result
