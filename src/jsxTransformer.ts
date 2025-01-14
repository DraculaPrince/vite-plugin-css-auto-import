import MagicString from 'magic-string';
import { parse } from '@babel/parser';
import traverse, { NodePath } from '@babel/traverse';
import {
	JSXAttribute,
	StringLiteral,
	isCallExpression,
	isIdentifier,
	isJSXExpressionContainer,
	isObjectExpression,
	isStringLiteral,
	isJSXAttribute,
	isJSXIdentifier,
} from '@babel/types';

// https://github.com/babel/babel/issues/13855
// @ts-ignore
let newTraverse: typeof traverse = null;
// const traverse = traverse.default as typeof traverse;
if (typeof traverse !== 'function') {
	newTraverse = (traverse as any).default;
} else {
	newTraverse = traverse;
}

export async function transformJSX({
	moduleId,
	styleModuleId,
	originalCode,
	manifest,
}: {
	moduleId: string;
	styleModuleId: string;
	originalCode: string;
	manifest: Record<string, string>;
}) {
	const source = new MagicString(originalCode);
	const ast = parse(originalCode, {
		plugins: ['typescript', 'jsx'],
		sourceType: 'module',
	});

	// 防止自动注入css
	// source.prepend(`import "${styleModuleId}";\n`);

	/**
	 * No need to walk through JSX if manifest is empty.
	 */
	if (Object.keys(manifest).length === 0) {
		return generateRollupTransformResult(source, moduleId);
	}

	newTraverse(ast, {
		JSXOpeningElement(path: any) {
			let classNameNode: any = null;
			let styleNameNode: any = null;
			// 这里判断是否是styleNameNode节点还是classNameNode节点
			path.node.attributes.forEach((attr: any) => {
				if (isJSXAttribute(attr) && isJSXIdentifier(attr.name)) {
					if (attr.name.name === 'className') {
						classNameNode = attr;
					}
					if (attr.name.name === 'styleName') {
						styleNameNode = attr;
						// path.node.attributes.splice(index, 1);
					}
				}
			});
			// 如果发现有styleNamenode节点就获取值合并到classNameNode节点里边，并且删除styleNameNode节点
			if (styleNameNode && classNameNode) {
				// Merge the values
				if (isStringLiteral(classNameNode.value) && isStringLiteral(styleNameNode.value)) {
					const { start, end } = styleNameNode;
					const newStart = start >= 1 ? start - 1 : start;
					source.remove(newStart, end);
					source.trimStart(start);
					// const newVal = classNameNode.value.value + ' ' + styleNameNode.value.value;
					const newVal =
						classNameNode.value.value + ' ' + manifest[styleNameNode.value.value] || styleNameNode.value.value;
					source.replace(classNameNode.value.value, newVal);
					classNameNode.value.value = newVal;
				}

				// Remove styleName attribute
				// console.log(path.node.attributes.indexOf(styleNameNode), 9999);
				// console.log(path.node.attributes, 'begin');
				path.node.attributes.splice(path.node.attributes.indexOf(styleNameNode), 1);
				//  console.log(path.node.attributes, 'end');
			}
			if (styleNameNode && !classNameNode) {
				// source.replace('styleName', 'className');
				const { start } = styleNameNode;
				source.update(start, start + 9, 'className')
				styleNameNode.name.name = 'className';
				styleNameNode.value.value = manifest[styleNameNode.value.value] || styleNameNode.value.value;
				// Remove styleName attribute
				// console.log(path.node.attributes.indexOf(styleNameNode), 9999);
				// console.log(path.node.attributes, 'begin');
				// path.node.attributes.splice(
				//   path.node.attributes.indexOf(styleNameNode),
				//   1
				// );
			}
		},

		JSXAttribute(path) {
			const { value } = path.node;

			if (isClassAttributePath(path)) {
				/**
				 * Handle the simplest case: <div class="foobar" />
				 */
				if (isStringLiteral(value)) {
					transformClassStringLiteral(value);
				}

				/**
				 * Handle className helper functions, e.g:
				 * <div class={ classNames({ foo: true }, ["bar", "baz"]) }/>
				 */
				if (isJSXExpressionContainer(value) && isCallExpression(value.expression)) {
					transformClassNamesObject(path);
					transformArrayMemberClassName(path);
					return;
				}

				return;
			}

			if (isClassListAttributePath(path) && isJSXExpressionContainer(value) && isObjectExpression(value.expression)) {
				transformClassNamesObject(path);
			}
		},
	});

	function transformClassStringLiteral(value: StringLiteral) {
		const { start, end } = value;
		const classSegments = value.value.split(' ').filter(s => !!s);
		const resolvedClassSegments = classSegments.map(className => {
			return manifest[className] || className;
		});
		const finalClassName = resolvedClassSegments.join(' ');
		source.overwrite(start!, end!, `"${finalClassName}"`);
	}

	function transformClassNamesObject(path: NodePath) {
		const node = path.node;
		newTraverse(node, {
			noScope: true,
			ObjectProperty(prop) {
				if (isIdentifier(prop.node.key)) {
					const { start, end } = prop.node.key;
					const { name } = prop.node.key;
					source.overwrite(start!, end!, `"${manifest[name] || name}"`);
					return;
				}

				if (isStringLiteral(prop.node.key)) {
					transformClassStringLiteral(prop.node.key);
				}
			},
		});
	}

	function transformArrayMemberClassName(path: NodePath) {
		const node = path.node;
		newTraverse(node, {
			noScope: true,
			ArrayExpression(prop) {
				prop.node.elements.forEach(element => {
					if (isStringLiteral(element)) {
						transformClassStringLiteral(element);
					}
				});
			},
		});
	}

	return generateRollupTransformResult(source, moduleId);
}

function generateRollupTransformResult(source: MagicString, moduleId: string) {
	return {
		code: source.toString(),
		map: source.generateMap({
			source: moduleId,
		}),
	};
}

function isClassAttributePath(path: NodePath<JSXAttribute>) {
	return path.node.name.name === 'class' || path.node.name.name === 'className';
}

function isClassListAttributePath(path: NodePath<JSXAttribute>) {
	return path.node.name.name === 'classList';
}
