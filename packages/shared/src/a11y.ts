export interface A11yNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  text?: string;
  children: A11yNode[];
}

export interface A11yTree {
  root: A11yNode;
  capturedAt: string;
  url: string;
}
