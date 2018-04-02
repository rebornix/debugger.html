/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at <http://mozilla.org/MPL/2.0/>. */

// @flow

import PropTypes from "prop-types";
import React, { PureComponent } from "react";
import ReactDOM from "react-dom";
import { connect } from "react-redux";
import classnames from "classnames";
import { isLoaded } from "../../utils/source";
// import { isFirefox } from "devtools-config";
import { features } from "../../utils/prefs";
import { getIndentation } from "../../utils/indentation";

import {
  getActiveSearch,
  getSelectedLocation,
  getSelectedSource,
  getHitCountForSource,
  getCoverageEnabled,
  getConditionalPanelLine,
  getSymbols,
  getEmptyLines
} from "../../selectors";

// Redux actions
import { bindActionCreators } from "redux";
import actions from "../../actions";

import Footer from "./Footer";
import SearchBar from "./SearchBar";
import HighlightLines from "./HighlightLines";
import Preview from "./Preview";
import Breakpoints from "./Breakpoints";
import HitMarker from "./HitMarker";
import CallSites from "./CallSites";
import DebugLine from "./DebugLine";
import HighlightLine from "./HighlightLine";
// import EmptyLines from "./EmptyLines";
import GutterMenu from "./GutterMenu";
import EditorMenu from "./EditorMenu";
import ConditionalPanel from "./ConditionalPanel";
import type { SymbolDeclarations } from "../../workers/parser/types";

import SourceEditor from "../../utils/monaco/source-editor";
import {
  shouldShowFooter,
  toSourceLine,
  toEditorLine
} from "../../utils/monaco";
import {
  updateDocument,
  hasDocument,
  getDocument,
  showLoading,
  showSourceText,
  clearEditor,
  showErrorMessage
} from "../../utils/monaco/source-documents";

import { resizeToggleButton } from "../../utils/ui";

import "./Editor.css";
import "./Highlight.css";
import "./EmptyLines.css";

const cssVars = {
  searchbarHeight: "var(--editor-searchbar-height)",
  secondSearchbarHeight: "var(--editor-second-searchbar-height)",
  footerHeight: "var(--editor-footer-height)"
};

export type Props = {
  hitCount: Object,
  selectedLocation: Object,
  selectedSource: Object,
  searchOn: boolean,
  coverageOn: boolean,
  horizontal: boolean,
  startPanelSize: number,
  endPanelSize: number,
  conditionalPanelLine: number,
  symbols: SymbolDeclarations,
  emptyLines: Object,

  // Actions
  openConditionalPanel: (?number) => void,
  closeConditionalPanel: void => void,
  setContextMenu: (string, any) => void,
  continueToHere: (?number) => void,
  toggleBreakpoint: (?number) => void,
  addOrToggleDisabledBreakpoint: (?number) => void,
  jumpToMappedLocation: any => void,
  traverseResults: (boolean, Object) => void
};

const emptyLineDecorationOpt = {
  marginClassName: "empty-line",
  stickiness: 1
};

type State = {
  editor: SourceEditor
};

class Editor extends PureComponent<Props, State> {
  $editorWrapper: ?HTMLDivElement;
  emptyLineDecorations: any[];

  constructor(props: Props) {
    super(props);

    this.state = {
      highlightedLineRange: null,
      editor: null
    };

    this.emptyLineDecorations = [];
  }

  componentWillReceiveProps(nextProps) {
    if (!this.state.editor) {
      return;
    }

    resizeToggleButton(this.state.editor.monaco);
  }

  componentWillUpdate(nextProps) {
    this.setText(nextProps);
    this.setSize(nextProps);
    this.setEmptyLines(nextProps);
    this.scrollToLocation(nextProps);
  }

  setupEditor() {
    const editor = new SourceEditor({
      theme: "vs-dark",
      readOnly: true,
      overviewRulerLanes: 0,
      selectOnLineNumbers: false,
      hideCursorInOverviewRuler: true,
      selectionHighlight: false,
      overviewRulerBorder: false,
      scrollBeyondLastLine: false,
      renderLineHighlight: "none",
      fixedOverflowWidgets: true,
      lineNumbersMinChars: 3,
      folding: true,
      showFoldingControls: "mouseover",
      minimap: {
        enabled: false
      },
      renderIndentGuides: false,
      cursorBlinking: "blink"
    });

    const node = ReactDOM.findDOMNode(this);
    if (node instanceof HTMLElement) {
      editor.appendToLocalElement(node.querySelector(".editor-mount"));
    }

    document.addEventListener("contextmenu", (e: MouseEvent) => {
      if (e.target.id === "contextmenu-mask") {
        e.preventDefault();
        e.stopPropagation();
      }
      return false;
    });

    editor.monaco.onMouseDown(e => {
      const data = e.target.detail;
      if (e.target.type < 2 || e.target.type > 4 || data.isAfterLines) {
        return;
      }

      // gutterClick

      if (e.event.leftButton) {
        if (
          e.target.type === 4 &&
          e.target.element.className.indexOf("folding") > 0
        ) {
          // folding
          return;
        }
        this.onGutterClick(e.target.position.lineNumber, e.event);
      } else if (e.event.rightButton) {
        this.onGutterContextMenu(e.target.position.lineNumber, e.event);
      }
      return false;
    });

    /**
     * we don't need following actions anymore
     * `toggleFoldMarkerVisibility` as we set showFoldingControls to "mouseover"
     * `resizeBreakpointGutter` our breakpoint element width can be 100%
     * `codeMirrorWrapper.tabIndex/onKeyDown/onClick`, Monaco is focusable.
     */
    resizeToggleButton(editor.monaco);

    // @Peng: I don't understand.
    // if (!isFirefox()) {
    //   codeMirror.on("gutterContextMenu", (cm, line, eventName, event) =>
    //     this.onGutterContextMenu(event)
    //   );
    //   codeMirror.on("contextmenu", (cm, event) => this.openMenu(event));
    // } else {
    //   codeMirrorWrapper.addEventListener("contextmenu", event =>
    //     this.openMenu(event)
    //   );
    // }

    this.setState({ editor });
    return editor;
  }

  componentDidMount() {
    const editor = this.setupEditor();

    const { selectedSource } = this.props;
    const { shortcuts } = this.context;

    const searchAgainKey = L10N.getStr("sourceSearch.search.again.key2");
    const searchAgainPrevKey = L10N.getStr(
      "sourceSearch.search.againPrev.key2"
    );

    shortcuts.on(L10N.getStr("toggleBreakpoint.key"), this.onToggleBreakpoint);
    shortcuts.on(
      L10N.getStr("toggleCondPanel.key"),
      this.onToggleConditionalPanel
    );
    shortcuts.on("Esc", this.onEscape);
    shortcuts.on(searchAgainPrevKey, this.onSearchAgain);
    shortcuts.on(searchAgainKey, this.onSearchAgain);

    updateDocument(editor, selectedSource);
  }

  componentWillUnmount() {
    if (this.state.editor) {
      this.state.editor.destroy();
      this.setState({ editor: null });
    }

    const searchAgainKey = L10N.getStr("sourceSearch.search.again.key2");
    const searchAgainPrevKey = L10N.getStr(
      "sourceSearch.search.againPrev.key2"
    );
    const shortcuts = this.context.shortcuts;
    shortcuts.off(L10N.getStr("toggleBreakpoint.key"));
    shortcuts.off(L10N.getStr("toggleCondPanel.key"));
    shortcuts.off(searchAgainPrevKey);
    shortcuts.off(searchAgainKey);
  }

  componentDidUpdate(prevProps, prevState) {
    // NOTE: when devtools are opened, the editor is not set when
    // the source loads so we need to wait until the editor is
    // set to update the text and size.
    if (!prevState.editor && this.state.editor) {
      this.setText(this.props);
      this.setEmptyLines(this.props);
      this.setSize(this.props);
    }
  }

  getCurrentLine() {
    return this.state.editor.getSelection().startLineNumber;
  }

  onToggleBreakpoint = (key, e) => {
    e.preventDefault();
    e.stopPropagation();
    const { selectedSource, conditionalPanelLine } = this.props;

    if (!selectedSource) {
      return;
    }

    const line = this.getCurrentLine();

    if (e.shiftKey) {
      this.toggleConditionalPanel(line);
    } else if (!conditionalPanelLine) {
      this.props.toggleBreakpoint(line);
    } else {
      this.toggleConditionalPanel(line);
      this.props.toggleBreakpoint(line);
    }
  };

  onToggleConditionalPanel = (key, e) => {
    e.stopPropagation();
    e.preventDefault();
    const line = this.getCurrentLine();
    this.toggleConditionalPanel(line);
  };

  /*
   * The default Esc command is overridden in the CodeMirror keymap to allow
   * the Esc keypress event to be catched by the toolbox and trigger the
   * split console. Restore it here, but preventDefault if and only if there
   * is a multiselection.
   */
  onEscape = (key, e) => {
    if (!this.state.editor) {
      return;
    }

    // const { codeMirror } = this.state.editor;
    // if (codeMirror.listSelections().length > 1) {
    //   codeMirror.execCommand("singleSelection");
    //   e.preventDefault();
    // }
  };

  onSearchAgain = (_, e) => {
    this.props.traverseResults(e.shiftKey, this.state.editor);
  };

  openMenu(event) {
    event.stopPropagation();
    event.preventDefault();

    const { setContextMenu } = this.props;
    if (event.target.classList.contains("CodeMirror-linenumber")) {
      return setContextMenu("Gutter", event);
    }

    return setContextMenu("Editor", event);
  }

  onGutterClick = (line, ev) => {
    ev.stopPropagation();
    ev.preventDefault();

    const {
      selectedSource,
      conditionalPanelLine,
      closeConditionalPanel,
      addOrToggleDisabledBreakpoint,
      toggleBreakpoint,
      continueToHere
    } = this.props;

    if (conditionalPanelLine) {
      return closeConditionalPanel();
    }

    const sourceLine = toSourceLine(selectedSource.get("id"), line);

    if (ev.altKey) {
      return continueToHere(sourceLine);
    }

    if (ev.shiftKey) {
      return addOrToggleDisabledBreakpoint(sourceLine);
    }

    return toggleBreakpoint(sourceLine);
  };

  onGutterContextMenu = (line, event) => {
    event.stopPropagation();
    event.preventDefault();
    event.line = line;
    return this.props.setContextMenu("Gutter", event);
  };

  toggleConditionalPanel = line => {
    const {
      conditionalPanelLine,
      closeConditionalPanel,
      openConditionalPanel
    } = this.props;

    if (conditionalPanelLine) {
      return closeConditionalPanel();
    }

    return openConditionalPanel(line);
  };

  closeConditionalPanel = () => {
    return this.props.closeConditionalPanel();
  };

  shouldScrollToLocation(nextProps) {
    const { selectedLocation, selectedSource } = this.props;
    const { editor } = this.state;

    if (!nextProps.selectedSource || !editor || !nextProps.selectedLocation) {
      return false;
    }

    if (!isLoaded(nextProps.selectedSource)) {
      return false;
    }

    if (!nextProps.selectedLocation.line) {
      return false;
    }

    const isFirstLoad =
      (!selectedSource || !isLoaded(selectedSource)) &&
      isLoaded(nextProps.selectedSource);

    const locationChanged = selectedLocation !== nextProps.selectedLocation;
    return isFirstLoad || locationChanged;
  }

  scrollToLocation(nextProps) {
    const { editor } = this.state;

    if (this.shouldScrollToLocation(nextProps)) {
      const line = nextProps.selectedLocation.line;
      let column = nextProps.selectedLocation.column;
      // let { line, column } = toEditorPosition(nextProps.selectedLocation);

      if (hasDocument(nextProps.selectedSource.get("id"))) {
        const doc = getDocument(nextProps.selectedSource.get("id"));
        const lineText = doc.getLineContent(line);
        column = Math.max(column, getIndentation(lineText));
      }

      editor.monaco.revealPosition({ lineNumber: line, column: column });
    }
  }

  setSize(nextProps) {
    if (!this.state.editor) {
      return;
    }

    if (
      nextProps.startPanelSize !== this.props.startPanelSize ||
      nextProps.endPanelSize !== this.props.endPanelSize
    ) {
      this.state.editor.monaco.layout();
    }
  }

  setText(props) {
    const { selectedSource, symbols } = props;

    if (!this.state.editor) {
      return;
    }

    if (!selectedSource) {
      return this.clearEditor();
    }

    // we are going to change editor's content, the decorations`` will be deleted.
    this.emptyLineDecorations = [];

    if (!isLoaded(selectedSource)) {
      return showLoading(this.state.editor);
    }

    if (selectedSource.get("error")) {
      return this.showErrorMessage(selectedSource.get("error"));
    }
    if (selectedSource) {
      return showSourceText(this.state.editor, selectedSource.toJS(), symbols);
    }
  }

  setEmptyLines(nextProps) {
    const { selectedSource, emptyLines } = nextProps;
    const { editor } = this.state;

    if (!editor) {
      return;
    }

    if (!emptyLines) {
      return;
    }

    const newDecorations = emptyLines.map(emptyLine => {
      const line = toEditorLine(selectedSource.get("id"), emptyLine);
      return {
        options: emptyLineDecorationOpt,
        range: {
          startLineNumber: line,
          startColumn: 1,
          endLineNumber: line,
          endColumn: 1
        }
      };
    });

    this.emptyLineDecorations = editor.monaco.deltaDecorations(
      this.emptyLineDecorations,
      newDecorations
    );
  }

  clearEditor() {
    const { editor } = this.state;
    if (!editor) {
      return;
    }

    clearEditor(editor);
  }

  showErrorMessage(msg) {
    const { editor } = this.state;
    if (!editor) {
      return;
    }

    showErrorMessage(editor, msg);
  }

  getInlineEditorStyles() {
    const { selectedSource, horizontal, searchOn } = this.props;

    const subtractions = [];

    if (shouldShowFooter(selectedSource, horizontal)) {
      subtractions.push(cssVars.footerHeight);
    }

    if (searchOn) {
      subtractions.push(cssVars.searchbarHeight);
      subtractions.push(cssVars.secondSearchbarHeight);
    }

    return {
      height:
        subtractions.length === 0
          ? "100%"
          : `calc(100% - ${subtractions.join(" - ")})`
    };
  }

  renderHitCounts() {
    const { hitCount, selectedSource } = this.props;

    if (
      !selectedSource ||
      !isLoaded(selectedSource) ||
      !hitCount ||
      !this.state.editor
    ) {
      return;
    }

    return hitCount
      .filter(marker => marker.get("count") > 0)
      .map(marker => (
        <HitMarker
          key={marker.get("line")}
          hitData={marker.toJS()}
          editor={this.state.editor.codeMirror}
        />
      ));
  }

  renderItems() {
    const { horizontal, selectedSource } = this.props;
    const { editor } = this.state;

    if (!editor || !selectedSource) {
      return null;
    }

    return (
      <div>
        <DebugLine editor={editor} />
        <HighlightLine editor={editor} />
        <Breakpoints editor={editor} />
        <Preview editor={editor} />;
        <Footer editor={editor} horizontal={horizontal} />
        <HighlightLines editor={editor} />
        <EditorMenu editor={editor} />
        <GutterMenu editor={editor} />
        <ConditionalPanel editor={editor} />
        {features.columnBreakpoints ? <CallSites editor={editor} /> : null}
        {this.renderHitCounts()}
      </div>
    );
  }

  renderSearchBar() {
    const { editor } = this.state;

    if (!editor) {
      return null;
    }

    return <SearchBar editor={editor} />;
  }

  render() {
    const { coverageOn } = this.props;

    return (
      <div
        className={classnames("editor-wrapper", {
          "coverage-on": coverageOn
        })}
        ref={c => (this.$editorWrapper = c)}
      >
        {this.renderSearchBar()}
        <div
          className="editor-mount devtools-monospace"
          style={this.getInlineEditorStyles()}
        />
        {this.renderItems()}
      </div>
    );
  }
}

Editor.contextTypes = {
  shortcuts: PropTypes.object
};

const mapStateToProps = state => {
  const selectedSource = getSelectedSource(state);
  const sourceId = selectedSource ? selectedSource.get("id") : "";
  return {
    selectedLocation: getSelectedLocation(state),
    selectedSource,
    searchOn: getActiveSearch(state) === "file",
    hitCount: getHitCountForSource(state, sourceId),
    coverageOn: getCoverageEnabled(state),
    conditionalPanelLine: getConditionalPanelLine(state),
    symbols: getSymbols(state, selectedSource && selectedSource.toJS()),
    emptyLines: selectedSource
      ? getEmptyLines(state, selectedSource.toJS())
      : []
  };
};

export default connect(mapStateToProps, dispatch =>
  bindActionCreators(actions, dispatch)
)(Editor);
