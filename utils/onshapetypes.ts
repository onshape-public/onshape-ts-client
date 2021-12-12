
export interface BasicNode {
  id: string;
  name: string;
  description?: string;
  href?: string;
}

export interface NodeOwner extends BasicNode {
  type: number;
}

export const DOCUMENT_SUMMARY = 'document-summary';
export const FOLDER = 'folder';
export type JsonType = 'document-summary' | 'folder';

export interface GlobalNode extends BasicNode {
  jsonType?: JsonType;
  owner?: NodeOwner;
  createdBy?: NodeOwner;
  modifiedBy?: NodeOwner;
}

export interface DocumentNode extends GlobalNode {
  defaultWorkspace?: BasicNode;
  parentId?: string;
}

export interface WorkspaceRef {
  documents?: DocumentNode[];
}

export interface GlobalNodeList {
  previous?: string;
  next?: string;
  href?: string;
  items?: GlobalNode[];
}