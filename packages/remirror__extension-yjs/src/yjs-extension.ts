import {
  absolutePositionToRelativePosition,
  defaultCursorBuilder,
  defaultDeleteFilter,
  redo,
  relativePositionToAbsolutePosition,
  undo,
  yCursorPlugin,
  ySyncPlugin,
  ySyncPluginKey,
  yUndoPlugin,
  yUndoPluginKey,
} from 'y-prosemirror';
import type {
  Doc,
  Map as YMap,
  RelativePosition,
  Transaction as YjsTransaction,
  XmlFragment as YXmlFragment,
} from 'yjs';
import { transact, UndoManager } from 'yjs';
import {
  AcceptUndefined,
  command,
  convertCommand,
  Dispose,
  EditorState,
  ErrorConstant,
  extension,
  ExtensionPriority,
  invariant,
  isEmptyObject,
  isFunction,
  keyBinding,
  KeyBindingProps,
  NamedShortcut,
  nonChainable,
  NonChainableCommandFunction,
  OnSetOptionsProps,
  PlainExtension,
  ProsemirrorPlugin,
  Selection,
  Shape,
  Static,
} from '@remirror/core';
import {
  Annotation,
  AnnotationExtension,
  AnnotationStore,
  OmitText,
  OmitTextAndPosition,
} from '@remirror/extension-annotation';
import { ExtensionHistoryMessages as Messages } from '@remirror/messages';

export interface ColorDef {
  light: string;
  dark: string;
}

export interface YSyncOpts {
  colors?: ColorDef[];
  colorMapping?: Map<string, ColorDef>;
  permanentUserData?: any | null;
}

/**
 * yjs typings are very rough; so we define here the interface that we require
 * (y-webrtc and y-websocket providers are both compatible with this interface;
 * no other providers have been checked).
 */
interface YjsRealtimeProvider {
  doc: Doc;
  awareness: any;
  destroy: () => void;
  disconnect: () => void;
}

export interface YjsOptions<Provider extends YjsRealtimeProvider = YjsRealtimeProvider> {
  /**
   * Get the provider for this extension.
   */
  getProvider: Provider | (() => Provider);

  /**
   * Remove the active provider. This should only be set at initial construction
   * of the editor.
   */
  destroyProvider?: (provider: Provider) => void;

  /**
   * The options which are passed through to the Yjs sync plugin.
   */
  syncPluginOptions?: AcceptUndefined<YSyncOpts>;

  /**
   * Take the user data and transform it into a html element which is used for
   * the cursor. This is passed into the cursor builder.
   *
   * See https://github.com/yjs/y-prosemirror#remote-cursors
   */
  cursorBuilder?: (user: Shape) => HTMLElement;

  /**
   * By default all editor bindings use the awareness 'cursor' field to
   * propagate cursor information.
   *
   * @default 'cursor'
   */
  cursorStateField?: string;

  /**
   * Get the current editor selection.
   *
   * @default `(state) => state.selection`
   */
  getSelection?: (state: EditorState) => Selection;

  disableUndo?: Static<boolean>;

  /**
   * Names of nodes in the editor which should be protected.
   *
   * @default `new Set('paragraph')`
   */
  protectedNodes?: Static<Set<string>>;
  trackedOrigins?: Static<any[]>;
}

interface YjsAnnotationPosition {
  from: RelativePosition;
  to: RelativePosition;
}

/**
 * Data stored for annotations inside the Y.Doc
 *
 * Note that these fields are part of the API, and changes may require handling
 * older stored documents.
 */
type StoredType<Type extends Annotation> = OmitTextAndPosition<Type> & YjsAnnotationPosition;

class YjsAnnotationStore<Type extends Annotation> implements AnnotationStore<Type> {
  type: YXmlFragment;
  map: YMap<StoredType<Type>>;

  constructor(
    private readonly doc: Doc,
    pmName: string,
    mapName: string,
    private readonly getMapping: () => /* ProsemirrorMapping */ any,
  ) {
    this.type = doc.getXmlFragment(pmName);
    this.map = doc.getMap(mapName);
  }

  addAnnotation({ from, to, ...data }: OmitText<Type>): void {
    // XXX: Why is this cast needed?
    const storedData: StoredType<Type> = {
      ...data,
      from: this.absolutePositionToRelativePosition(from),
      to: this.absolutePositionToRelativePosition(to),
    } as StoredType<Type>;
    this.map.set(data.id, storedData);
  }

  updateAnnotation(id: string, updateData: OmitTextAndPosition<Type>): void {
    const existing = this.map.get(id);

    if (!existing) {
      return;
    }

    this.map.set(id, {
      ...updateData,
      from: existing.from,
      to: existing.to,
    });
  }

  removeAnnotations(ids: string[]): void {
    transact(this.doc, () => {
      ids.forEach((id) => this.map.delete(id));
    });
  }

  setAnnotations(annotations: Array<OmitText<Type>>): void {
    transact(this.doc, () => {
      this.map.clear();
      annotations.forEach((annotation) => this.addAnnotation(annotation));
    });
  }

  formatAnnotations(): Array<OmitText<Type>> {
    const result: Array<OmitText<Type>> = [];
    this.map.forEach(({ from: relFrom, to: relTo, ...data }) => {
      const from = this.relativePositionToAbsolutePosition(relFrom);
      const to = this.relativePositionToAbsolutePosition(relTo);

      if (!from || !to) {
        return;
      }

      // XXX: Why is this cast needed?
      result.push({ ...data, from, to } as unknown as OmitText<Type>);
    });
    return result;
  }

  private absolutePositionToRelativePosition(pos: number): RelativePosition {
    const mapping = this.getMapping();
    return absolutePositionToRelativePosition(pos, this.type, mapping);
  }

  private relativePositionToAbsolutePosition(relPos: RelativePosition): number | null {
    const mapping = this.getMapping();
    return relativePositionToAbsolutePosition(this.doc, this.type, relPos, mapping);
  }
}

/**
 * The YJS extension is the recommended extension for creating a collaborative
 * editor.
 */
@extension<YjsOptions>({
  defaultOptions: {
    getProvider: (): never => {
      invariant(false, {
        code: ErrorConstant.EXTENSION,
        message: 'You must provide a YJS Provider to the `YjsExtension`.',
      });
    },
    destroyProvider: defaultDestroyProvider,
    syncPluginOptions: undefined,
    cursorBuilder: defaultCursorBuilder,
    cursorStateField: 'cursor',
    getSelection: (state) => state.selection,
    disableUndo: false,
    protectedNodes: new Set('paragraph'),
    trackedOrigins: [],
  },
  staticKeys: ['disableUndo', 'protectedNodes', 'trackedOrigins'],
  defaultPriority: ExtensionPriority.High,
})
export class YjsExtension extends PlainExtension<YjsOptions> {
  get name() {
    return 'yjs' as const;
  }

  private _provider?: YjsRealtimeProvider;

  /**
   * The provider that is being used for the editor.
   */
  get provider(): YjsRealtimeProvider {
    const { getProvider } = this.options;

    return (this._provider ??= getLazyValue(getProvider));
  }

  getBinding(): { mapping: Map<any, any> } | undefined {
    const state = this.store.getState();
    const { binding } = ySyncPluginKey.getState(state);
    return binding;
  }

  onView(): Dispose | void {
    try {
      const annotationStore = new YjsAnnotationStore(
        this.provider.doc,
        'prosemirror',
        'annotations',
        () => this.getBinding()?.mapping,
      );
      this.store.manager.getExtension(AnnotationExtension).setOptions({
        getStore: () => annotationStore,
      });

      const handler = (_update: Uint8Array, _origin: any, _doc: Doc, yjsTr: YjsTransaction) => {
        // Ignore own changes
        if (yjsTr.local) {
          return;
        }

        this.store.commands.redrawAnnotations?.();
      };
      this.provider.doc.on('update', handler);
      return () => {
        this.provider.doc.off('update', handler);
      };
    } catch {
      // AnnotationExtension isn't present in editor
    }
  }

  /**
   * Create the yjs plugins.
   */
  createExternalPlugins(): ProsemirrorPlugin[] {
    const {
      syncPluginOptions,
      cursorBuilder,
      getSelection,
      cursorStateField,
      disableUndo,
      protectedNodes,
      trackedOrigins,
    } = this.options;

    const yDoc = this.provider.doc;
    const type = yDoc.getXmlFragment('prosemirror');

    const plugins = [
      ySyncPlugin(type, syncPluginOptions),
      yCursorPlugin(
        this.provider.awareness,
        { cursorBuilder, cursorStateField, getSelection },
        cursorStateField,
      ),
    ];

    if (!disableUndo) {
      const undoManager = new UndoManager(type, {
        trackedOrigins: new Set([ySyncPluginKey, ...trackedOrigins]),
        deleteFilter: (item) => defaultDeleteFilter(item, protectedNodes),
      });
      plugins.push(yUndoPlugin({ undoManager }));
    }

    return plugins;
  }

  /**
   * This managers the updates of the collaboration provider.
   */
  onSetOptions(props: OnSetOptionsProps<YjsOptions>): void {
    const { changes, pickChanged } = props;
    const changedPluginOptions = pickChanged([
      'cursorBuilder',
      'cursorStateField',
      'getProvider',
      'getSelection',
      'syncPluginOptions',
    ]);

    if (changes.getProvider.changed) {
      this._provider = undefined;
      const previousProvider = getLazyValue(changes.getProvider.previousValue);

      // Check whether the values have changed.
      if (changes.destroyProvider.changed) {
        changes.destroyProvider.previousValue?.(previousProvider);
      } else {
        this.options.destroyProvider(previousProvider);
      }
    }

    if (!isEmptyObject(changedPluginOptions)) {
      this.store.updateExtensionPlugins(this);
    }
  }

  /**
   * Remove the provider from the manager.
   */
  onDestroy(): void {
    if (!this._provider) {
      return;
    }

    this.options.destroyProvider(this._provider);
    this._provider = undefined;
  }

  /**
   * Undo that last Yjs transaction(s)
   *
   * This command does **not** support chaining.
   * This command is a no-op and always returns `false` when the `disableUndo` option is set.
   */
  @command({
    disableChaining: true,
    description: ({ t }) => t(Messages.UNDO_DESCRIPTION),
    label: ({ t }) => t(Messages.UNDO_LABEL),
    icon: 'arrowGoBackFill',
  })
  yUndo(): NonChainableCommandFunction {
    return nonChainable((props) => {
      if (this.options.disableUndo) {
        return false;
      }

      const { state, dispatch } = props;
      const undoManager: UndoManager = yUndoPluginKey.getState(state).undoManager;

      if (undoManager.undoStack.length === 0) {
        return false;
      }

      if (!dispatch) {
        return true;
      }

      return convertCommand(undo)(props);
    });
  }

  /**
   * Redo the last transaction undone with a previous `yUndo` command.
   *
   * This command does **not** support chaining.
   * This command is a no-op and always returns `false` when the `disableUndo` option is set.
   */
  @command({
    disableChaining: true,
    description: ({ t }) => t(Messages.REDO_DESCRIPTION),
    label: ({ t }) => t(Messages.REDO_LABEL),
    icon: 'arrowGoForwardFill',
  })
  yRedo(): NonChainableCommandFunction {
    return nonChainable((props) => {
      if (this.options.disableUndo) {
        return false;
      }

      const { state, dispatch } = props;
      const undoManager: UndoManager = yUndoPluginKey.getState(state).undoManager;

      if (undoManager.redoStack.length === 0) {
        return false;
      }

      if (!dispatch) {
        return true;
      }

      return convertCommand(redo)(props);
    });
  }

  /**
   * Handle the undo keybinding.
   */
  @keyBinding({ shortcut: NamedShortcut.Undo, command: 'yUndo' })
  undoShortcut(props: KeyBindingProps): boolean {
    return this.yUndo()(props);
  }

  /**
   * Handle the redo keybinding for the editor.
   */
  @keyBinding({ shortcut: NamedShortcut.Redo, command: 'yRedo' })
  redoShortcut(props: KeyBindingProps): boolean {
    return this.yRedo()(props);
  }
}

/**
 * The default destroy provider method.
 */
export function defaultDestroyProvider(provider: YjsRealtimeProvider): void {
  const { doc } = provider;
  provider.disconnect();
  provider.destroy();
  doc.destroy();
}

function getLazyValue<Type>(lazyValue: Type | (() => Type)): Type {
  return isFunction(lazyValue) ? lazyValue() : lazyValue;
}

declare global {
  namespace Remirror {
    interface AllExtensions {
      yjs: YjsExtension;
    }
  }
}
