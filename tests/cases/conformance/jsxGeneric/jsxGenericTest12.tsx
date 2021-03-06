// @filename: file.tsx
// @jsx: react
/* @jsx-mode generic */
/* @jsx-intrinsic-factory createElement */

interface HTMLAttributes {
    class?:     string;
    id?:        string;
    onclick?:   (this: HTMLElement, ev: MouseEvent) => void;
}

export interface AddArray extends Array<AddNode> {}
export type AddNode    = HTMLElement|string|AddArray|false;

function createElement(tagName:"div"|"span", attrs?: HTMLAttributes, ...children:AddNode[]): HTMLElement {
    return document.createElement(tagName);
}

function test() {
    const f = <>
                <span>1</span>
                <span>2</span>
              </>;

    return <div class="test">
                <span/>
                { f }
           </div>;
}