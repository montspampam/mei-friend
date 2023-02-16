/**
 * Provides all the editor functions
 */

import * as speed from './speed.js';
import * as utils from './utils.js';
import * as dutils from './dom-utils.js';
import * as att from './attribute-classes.js';
import { loadFacsimile } from './facsimile.js';
import Viewer from './viewer.js';
import { handleEditorChanges, version, versionDate } from './main.js';

// smart indent selected region in editor, if none, do all
export function indentSelection(v, cm) {
  v.updateNotation = false;
  cm.blockChanges = true;
  let selections = cm.listSelections();
  selections.forEach((s) => {
    let l1 = s.anchor.line;
    let l2 = s.head.line;
    if (l1 > l2) {
      let tmp = l1;
      l1 = l2;
      l2 = tmp;
    }
    if (l1 === l2) {
      // do all if nothing selected
      l1 = 0;
      l2 = cm.lastLine();
    }
    for (let l = l1; l <= l2; l++) {
      cm.indentLine(l, 'smart');
    }
  });
  cm.blockChanges = false;
  handleEditorChanges();
  v.updateNotation = true;
} // indentSelection()

// delete selected elements
export function deleteElement(v, cm, modifyerKey = false) {
  v.loadXml(cm.getValue(), true);
  let id = v.selectedElements[0]; // TODO: iterate over selectedElements
  let cursor = cm.getCursor();
  let nextId = utils.getIdOfNextElement(cm, cursor.line)[0]; // TODO necessary?
  let element = v.xmlDoc.querySelector("[*|id='" + id + "']");
  console.info('Deleting: ', element);
  if (!element) {
    console.info(id + ' not found for deletion.');
    return;
  }
  let selectedElements = [];
  v.updateNotation = false;
  // let checkPoint = buffer.createCheckpoint(); TODO

  if (att.modelControlEvents.concat(['accid', 'artic', 'clef', 'octave', 'beamSpan']).includes(element.nodeName)) {
    if (element.nodeName === 'octave') {
      // reset notes inside octave range
      let disPlace = element.getAttribute('dis.place');
      let dis = element.getAttribute('dis');
      let id1 = utils.rmHash(element.getAttribute('startid'));
      let id2 = utils.rmHash(element.getAttribute('endid'));
      findAndModifyOctaveElements(cm, v.xmlDoc, id1, id2, disPlace, dis, false);
      removeInEditor(cm, element);
      selectedElements.push(id2);
    } else {
      removeInEditor(cm, element);
      // place cursor at a sensible place...
      let m = utils.getElementIdAtCursor(cm);
      let el = document.getElementById(m).querySelector(dutils.navElsSelector);
      if (el) selectedElements.push(el.getAttribute('id'));
      else selectedElements.push(nextId);
    }
  } else if (['beam'].includes(element.nodeName)) {
    // delete beam
    let p;
    let first = true;
    let childList = element.childNodes;
    for (let i = 0; i < childList.length; i++) {
      if (childList[i].nodeType === Node.TEXT_NODE) continue;
      if (first) {
        p = replaceInEditor(cm, element, false, childList[i]);
        p.end.line += 1;
        p.end.ch = 0;
        cm.setCursor(p.end);
        first = false;
      } else {
        // txtEdr.insertNewline();
        let newMEI = dutils.xmlToString(childList[i]);
        cm.replaceRange(newMEI + '\n', p.end);
        let cursor = cm.getCursor();
        for (let l = p.end.line; l < cursor.line; l++) cm.indentLine(l);
        p.end = cursor;
      }
      selectedElements.push(childList[i].getAttribute('xml:id'));
      element.parentNode.insertBefore(childList[i--], element);
    }
  } // delete Zone in source image display
  else if (element.nodeName === 'zone' && document.getElementById('editFacsimileZones').checked) {
    // remove zone; with CMD remove pointing element; without just remove @facs from pointing element
    removeZone(v, cm, element, modifyerKey);
  } else if (!document.getElementById('editFacsimileZones').checked) {
    v.show;
  } else {
    console.info('Element ' + id + ' not supported for deletion.');
    return;
  }
  element.remove();
  loadFacsimile(v.xmlDoc);
  // buffer.groupChangesSinceCheckpoint(checkPoint); TODO
  v.selectedElements = selectedElements;
  v.lastNoteId = v.selectedElements[v.selectedElements.length - 1];
  v.xmlDocOutdated = true;
  addApplicationInfo(v, cm);
  v.updateData(cm, false, true);
  v.updateNotation = true;
} // deleteElement()

export function addControlElement(v, cm, elName, placement, form) {
  if (v.selectedElements.length === undefined || v.selectedElements.length < 1) return;
  v.selectedElements = utils.sortElementsByScorePosition(v.selectedElements);
  v.selectedElements = speed.filterElements(v.selectedElements, v.xmlDoc);
  console.info('addControlElement() ', elName, placement, form);

  // find and validate startEl with @startId
  let startId = v.selectedElements[0];
  var startEl = v.xmlDoc.querySelector("[*|id='" + startId + "']");
  if (!startEl) return;
  if (!['note', 'chord', 'rest', 'mRest', 'multiRest'].includes(startEl.nodeName)) {
    console.info('addControlElement: Cannot add new element to start element' + startEl.nodeName + '.');
    return;
  }
  // staveArray lists staff numbers of all selected elements
  let staveArray = [];
  let startStaffNumber = startEl.closest('staff')?.getAttribute('n'); // get staff number for start element
  if (startStaffNumber) staveArray.push(startStaffNumber);
  // find and validate end element
  let endId = '';
  let sc = cm.getSearchCursor('xml:id="' + startId + '"');
  if (!sc.findNext()) return;
  const p = sc.from();
  var endEl;
  if (v.selectedElements.length === 1 && ['slur', 'tie', 'phrase', 'hairpin', 'gliss'].includes(elName)) {
    // if one selected element, find a second automatically
    endId = utils.getIdOfNextElement(cm, p.line, ['note'])[0];
  } else if (v.selectedElements.length >= 2) {
    endId = v.selectedElements[v.selectedElements.length - 1];
  }
  if (endId) {
    endEl = v.xmlDoc.querySelector("[*|id='" + endId + "']");
    if (!['note', 'chord', 'mRest', 'multiRest'].includes(endEl.nodeName)) {
      console.info('addControlElement: Cannot add new element to end element ' + endEl.nodeName);
      return;
    }
    const endStaffNumber = endEl.closest('staff')?.getAttribute('n');
    if (endStaffNumber && !staveArray.includes(endStaffNumber)) {
      staveArray.push(endStaffNumber);
    }
  }
  // check inner elements (without start/end) for staff numbers and add them, if missing in staveArray
  for (let i = 1; i < v.selectedElements.length - 2; i++) {
    let el = v.xmlDoc.querySelector("[*|id='" + v.selectedElements[i] + "']");
    let n = el?.closest('staff')?.getAttribute('n');
    if (!staveArray.includes(n)) staveArray.push(n);
  }
  // create element to be inserted
  let newElement = v.xmlDoc.createElementNS(dutils.meiNameSpace, elName);
  let uuid = utils.generateXmlId(elName, v.xmlIdStyle);
  newElement.setAttributeNS(dutils.xmlNameSpace, 'xml:id', uuid);
  // elements with both startid and endid
  if (['slur', 'tie', 'phrase', 'hairpin', 'gliss'].includes(elName)) {
    newElement.setAttribute('startid', '#' + startId);
    newElement.setAttribute('endid', '#' + endId);
  } else if (
    // only a @startid
    ['fermata', 'dir', 'dynam', 'tempo', 'pedal', 'mordent', 'trill', 'turn'].includes(elName)
  ) {
    newElement.setAttribute('startid', '#' + startId);
  }
  // add an optional endid
  if (endId && ['dir', 'dynam', 'mordent', 'trill', 'turn'].includes(elName)) {
    newElement.setAttribute('endid', '#' + endId);
    if (['trill'].includes(elName)) {
      // @extender for endid
      newElement.setAttribute('extender', 'true');
    }
  }
  // handle @staff attribute of start element
  if (staveArray.length > 0) newElement.setAttribute('staff', staveArray.sort().join(' '));
  // handle @form attribute
  if (form && ['hairpin', 'fermata', 'mordent', 'trill', 'turn'].includes(elName)) {
    newElement.setAttribute('form', form);
  }
  if (placement && ['pedal'].includes(elName)) {
    newElement.setAttribute('dir', placement);
    newElement.setAttribute('vgrp', '100');
  }
  if (placement) {
    if (['slur', 'tie', 'phrase'].includes(elName)) {
      newElement.setAttribute('curvedir', placement);
    } else if (elName === 'arpeg') {
      newElement.setAttribute('order', placement);
    } else {
      newElement.setAttribute('place', placement);
    }
  }
  if (['arpeg'].includes(elName)) {
    newElement.setAttribute('plist', '#' + v.selectedElements.join(' #'));
  }
  if (form && ['dir', 'dynam', 'tempo'].includes(elName)) {
    newElement.appendChild(v.xmlDoc.createTextNode(form));
  }
  // add new element to txtEdr at end of measure
  v.updateNotation = false; // to prevent reloading after each edit
  if (p) {
    let p1 = utils.moveCursorToEndOfMeasure(cm, p); // resets selectedElements!!
    console.log('p1: ', p);
    cm.replaceRange(dutils.xmlToString(newElement) + '\n', cm.getCursor());
    cm.indentLine(p1.line, 'smart');
    cm.indentLine(p1.line + 1, 'smart');
    cm.setSelection(p1);
    console.log('Cursor pos: ', cm.getCursor());
  }
  // add new element to DOM
  var measureId = startEl.closest('measure').getAttribute('xml:id');
  v.xmlDoc.querySelector("[*|id='" + measureId + "']").appendChild(newElement); //.cloneNode(true));
  v.lastNoteId = startId;
  v.selectedElements = [];
  v.selectedElements.push(uuid);
  addApplicationInfo(v, cm);
  addApplicationInfo(v, cm);
  v.updateData(cm, false, true);
  v.updateNotation = true;
} // addControlElement()

export function addClefChange(v, cm, shape = 'G', line = '2', before = true) {
  if (v.selectedElements.length === 0) return;
  v.updateNotation = false; // stop update notation
  let id = v.selectedElements[0];
  var el = v.xmlDoc.querySelector("[*|id='" + id + "']");
  let chord = el.closest('chord');
  if (chord) id = chord.getAttribute('xml:id');
  utils.setCursorToId(cm, id);
  let newElement = v.xmlDoc.createElementNS(dutils.meiNameSpace, 'clef');
  let uuid = utils.generateXmlId('clef', v.xmlIdStyle);
  newElement.setAttributeNS(dutils.xmlNameSpace, 'xml:id', uuid);
  newElement.setAttribute('shape', shape);
  newElement.setAttribute('line', line);
  v.xmlDocOutdated = true;
  if (before) {
    cm.replaceRange(dutils.xmlToString(newElement) + '\n', cm.getCursor());
    // cm.execCommand('newLineAndIndent');
  } else {
    cm.execCommand('toMatchingTag');
    cm.execCommand('goLineEnd');
    cm.replaceRange('\n' + dutils.xmlToString(newElement), cm.getCursor());
  }
  cm.execCommand('indentAuto');
  v.updateNotation = true; // update notation again
  v.selectedElements = [];
  v.selectedElements.push(uuid);
  v.lastNoteId = uuid;
  v.updatePage(cm, '', uuid);
}

// Reverse or insert att:placement (artic, ...), att.curvature (slur, tie,
// phrase) and att.stems (note, chord) of current element
// (or its children, such as all notes/chords within a beam).
export function invertPlacement(v, cm, modifier = false) {
  v.loadXml(cm.getValue());
  let ids = utils.sortElementsByScorePosition(v.selectedElements);
  ids = speed.filterElements(ids, v.xmlDoc);
  console.info('invertPlacement ids: ', ids);
  v.updateNotation = false; // no need to redraw notation
  let noteList, range;
  for (let id of ids) {
    var el = v.xmlDoc.querySelector("[*|id='" + id + "']");
    let chordId = utils.insideParent(id);
    if (el && el.nodeName === 'note') {
      if (chordId) id = chordId;
      el = v.xmlDoc.querySelector("[*|id='" + id + "']");
    }
    if (!el) {
      console.info('invertPlacement(): element not found', id);
      continue;
    }
    let attr = '';
    let val = 'above';
    // placement above/below as in dir, dynam...
    if (att.attPlacement.includes(el.nodeName)) {
      attr = 'place';
      if (el.getAttribute(attr) === 'between' && el.hasAttribute('staff')) {
        let staves = el.getAttribute('staff');
        el.setAttribute('staff', staves.split(' ')[0]);
      }
      if (
        el.hasAttribute(attr) &&
        att.dataPlacement.includes(el.getAttribute(attr)) &&
        el.getAttribute(attr) !== 'below'
      ) {
        val = 'below';
      }
      if (modifier) {
        let staffList = getStaffNumbersForClosestStaffGroup(v, el);
        if (staffList.length === 2) {
          if (el.hasAttribute(attr)) {
            if (['above', 'below'].includes(el.getAttribute(attr))) {
              val = 'between';
              el.setAttribute('staff', staffList.sort().join(' '));
            } else {
              val = 'above';
              el.setAttribute('staff', staffList[0]);
            }
          }
        } else {
          let msg =
            'Editor invertPlacement: Cannot change placement to "between", as selected element does not sit in a staff group with two staves.';
          console.log(msg);
          v.showAlert(msg, 'warning');
        }
      }
      // for fermata, change form from inv to nothing or back
      if (el.nodeName === 'fermata') {
        val === 'below' ? el.setAttribute('form', 'inv') : el.removeAttribute('form');
      }
      el.setAttribute(attr, val);
      range = replaceInEditor(cm, el, true);
      // txtEdr.autoIndentSelectedRows();
    } else if (att.attCurvature.includes(el.nodeName)) {
      attr = 'curvedir';
      if (el.hasAttribute(attr) && el.getAttribute(attr) === 'above') {
        val = 'below';
      }
      el.setAttribute(attr, val);
      range = replaceInEditor(cm, el, true);
      // txtEdr.autoIndentSelectedRows();
    } else if (att.attStems.includes(el.nodeName)) {
      (attr = 'stem.dir'), (val = 'up');
      if (el.hasAttribute(attr) && el.getAttribute(attr) === val) {
        val = 'down';
      }
      el.setAttribute(attr, val);
      range = replaceInEditor(cm, el, true);
      // txtEdr.autoIndentSelectedRows();
      // invert @num.place within tuplet
    } else if (el.nodeName === 'tuplet') {
      attr = 'num.place';
      val = 'above';
      if (el.hasAttribute(attr) && el.getAttribute(attr) === val) {
        val = 'below';
      }
      el.setAttribute(attr, val);
      range = replaceInEditor(cm, el, true);
      // txtEdr.autoIndentSelectedRows();
    } else if (el.nodeName === 'beamSpan') {
      // replace individual notes in beamSpan
      (attr = 'stem.dir'), (val = 'up');
      let plist = el.getAttribute('plist');
      if (plist) {
        plist.split(' ').forEach((p) => {
          let note = v.xmlDoc.querySelector("[*|id='" + utils.rmHash(p) + "']");
          if (note) {
            if (note.parentNode.nodeName === 'chord') note = note.parentNode;
            if (note.hasAttribute(attr) && note.getAttribute(attr) === val) {
              val = 'down';
            }
            note.setAttribute(attr, val);
          }
          v.updateNotation = false; // no need to redraw notation
          range = replaceInEditor(cm, note, true);
        });
      }
      // find all note/chord elements children and execute InvertingAction
    } else if ((noteList = el.querySelectorAll('note, chord'))) {
      // console.info('noteList: ', noteList);
      (attr = 'stem.dir'), (val = 'up');
      for (let note of noteList) {
        // skip notes within chords
        if (note.parentNode.nodeName === 'chord') continue;
        if (note.hasAttribute(attr) && note.getAttribute(attr) === val) {
          val = 'down';
        }
        note.setAttribute(attr, val);
        v.updateNotation = false; // no need to redraw notation
        range = replaceInEditor(cm, note, true);
        // txtEdr.autoIndentSelectedRows();
      }
    } else {
      console.info('invertPlacement(): ' + el.nodeName + ' contains no elements to invert.');
    }
  }
  // console.info('TextCursor: ', txtEdr.getCursorBufferPosition());
  if (range) cm.setCursor(range.end);
  v.selectedElements = ids;
  addApplicationInfo(v, cm);
  v.updateData(cm, false, true);
  v.updateNotation = true; // update notation again
} // invertPlacement()

// toggle (switch on/off) artic to selected elements
export function toggleArtic(v, cm, artic = 'stacc') {
  v.loadXml(cm.getValue());
  let ids = speed.filterElements(v.selectedElements, v.xmlDoc);
  v.updateNotation = false;
  let i, range;
  for (i = 0; i < ids.length; i++) {
    let id = ids[i];
    // if an artic inside a note, look at note
    let parentId = utils.insideParent(id, 'note');
    if (parentId) id = parentId;
    // if note inside a chord, look at chord
    parentId = utils.insideParent(id, 'chord');
    if (parentId) id = parentId;
    let note = v.xmlDoc.querySelector("[*|id='" + id + "']");
    if (!note) continue;
    let uuid;
    let noteList;
    if (['note', 'chord'].includes(note.nodeName)) {
      uuid = toggleArticForNote(v, note, artic);
      uuid ? (ids[i] = uuid) : (ids[i] = id);
      range = replaceInEditor(cm, note, true);
      cm.execCommand('indentAuto');
    } else if ((noteList = utils.findNotes(id))) {
      let noteId;
      for (noteId of noteList) {
        note = v.xmlDoc.querySelector("[*|id='" + noteId + "']");
        uuid = toggleArticForNote(v, note, artic);
        range = replaceInEditor(cm, note, true);
        cm.execCommand('indentAuto');
      }
    }
  }
  if (range) cm.setCursor(range.end);
  v.selectedElements = ids;
  addApplicationInfo(v, cm);
  v.updateData(cm, false, true);
  v.updateNotation = true; // update notation again
} // toggleArtic()

// shift element (rests, note) up/down by pitch name (1 or 7 steps)
export function shiftPitch(v, cm, deltaPitch) {
  v.loadXml(cm.getValue());
  let ids = speed.filterElements(v.selectedElements, v.xmlDoc);
  v.updateNotation = false;
  let i;
  for (i = 0; i < ids.length; i++) {
    let id = ids[i];
    let el = v.xmlDoc.querySelector("[*|id='" + id + "']");
    if (!el) continue;
    let chs = Array.from(el.querySelectorAll('note,rest,mRest,multiRest'));
    if (chs.length > 0)
      // shift many elements
      chs.forEach((ele) => replaceInEditor(cm, pitchMover(ele, deltaPitch)));
    // shift one element
    else replaceInEditor(cm, pitchMover(el, deltaPitch));
  }
  v.selectedElements = ids;
  addApplicationInfo(v, cm);
  v.updateData(cm, false, true);
  v.updateNotation = true; // update notation again
} // shiftPitch()

export function moveElementToNextStaff(v, cm, upwards = true) {
  console.info('moveElementToNextStaff(' + (upwards ? 'up' : 'down') + ')');
  v.loadXml(cm.getValue());
  let ids = speed.filterElements(v.selectedElements, v.xmlDoc);
  v.updateNotation = false;
  let i;
  let noteList;
  for (i = 0; i < ids.length; i++) {
    let id = ids[i];
    let el = v.xmlDoc.querySelector("[*|id='" + id + "']");
    if (!el) continue;
    if (['note', 'chord', 'rest', 'mRest', 'multiRest'].includes(el.nodeName)) {
      staffMover(cm, el, upwards);
    } else if ((noteList = utils.findNotes(id))) {
      let noteId;
      for (noteId of noteList) {
        console.info('moving: ' + noteId);
        let sel = v.xmlDoc.querySelector("[*|id='" + noteId + "']");
        staffMover(cm, sel, upwards);
      }
    }
  }
  v.selectedElements = ids;
  addApplicationInfo(v, cm);
  v.updateData(cm, false, true);
  v.updateNotation = true; // update notation again
} // moveElementToNextStaff()

// add beam, only speed mode
export function addBeamElement(v, cm, elementName = 'beam') {
  v.loadXml(cm.getValue());
  v.selectedElements = speed.filterElements(v.selectedElements, v.xmlDoc);
  v.selectedElements = utils.sortElementsByScorePosition(v.selectedElements);
  if (v.selectedElements.length <= 1) return;
  // console.info('addBeamElement(' + elementName +
  //   '): selectedElements:', v.selectedElements);
  let id1 = v.selectedElements[0]; // xml:id string
  let parentId;
  if ((parentId = utils.insideParent(id1, 'chord'))) id1 = parentId;
  let id2 = v.selectedElements[v.selectedElements.length - 1];
  if ((parentId = utils.insideParent(id2, 'chord'))) id2 = parentId;
  let n1 = v.xmlDoc.querySelector("[*|id='" + id1 + "']");
  let n2 = v.xmlDoc.querySelector("[*|id='" + id2 + "']");
  let par1 = n1.parentNode;
  v.updateNotation = false;
  // let checkPoint = buffer.createCheckpoint(); TODO
  // add beam element, if selected elements have same parent
  // TODO check whether inside tuplets and accept that as well
  if (par1.getAttribute('xml:id') === n2.parentNode.getAttribute('xml:id')) {
    let beam = document.createElementNS(dutils.meiNameSpace, elementName);
    let uuid = utils.generateXmlId(elementName, v.xmlIdStyle);
    beam.setAttributeNS(dutils.xmlNameSpace, 'xml:id', uuid);
    par1.insertBefore(beam, n1);
    let nodeList = par1.childNodes;
    let insert = false;
    for (let i = 0; i < nodeList.length; i++) {
      if (nodeList[i].nodeType === Node.TEXT_NODE) continue;
      if (nodeList[i].getAttribute('xml:id') === id1) insert = true;
      if (nodeList[i].getAttribute('xml:id') === id2) {
        let n = nodeList[i].cloneNode(); // make a copy for replacement later
        beam.appendChild(nodeList[i--]);
        replaceInEditor(cm, n, true, beam);
        cm.execCommand('indentAuto');
        break;
      }
      if (insert) {
        removeInEditor(cm, nodeList[i]);
        beam.appendChild(nodeList[i--]);
      }
    }
    // buffer.groupChangesSinceCheckpoint(checkPoint); // TODO
    v.selectedElements = [];
    v.selectedElements.push(uuid);
    addApplicationInfo(v, cm);
    v.updateData(cm, false, true);
  } else {
    console.log('Cannot add ' + elementName + ' element, selected elements have different parents.');
  }
  v.updateNotation = true; // update notation again
} // addBeamElement()

// add beamSpan element
export function addBeamSpan(v, cm) {
  v.loadXml(cm.getValue());
  if (v.selectedElements.length < 1) return;
  // select chords instead of individual notes
  for (let i = 0; i < v.selectedElements.length; i++) {
    let chord = utils.insideParent(v.selectedElements[i], 'chord');
    if (chord && !v.selectedElements.includes(chord)) {
      v.selectedElements.unshift(chord);
      i++;
    }
  }
  v.selectedElements = speed.filterElements(v.selectedElements, v.xmlDoc);
  v.selectedElements = utils.sortElementsByScorePosition(v.selectedElements);
  let id1 = v.selectedElements[0]; // xml:id string
  let id2 = v.selectedElements[v.selectedElements.length - 1];
  // add control like element <octave @startid @endid @dis @dis.place>
  let beamSpan = v.xmlDoc.createElementNS(dutils.meiNameSpace, 'beamSpan');
  let uuid = utils.generateXmlId('beamSpan', v.xmlIdStyle);
  beamSpan.setAttributeNS(dutils.xmlNameSpace, 'xml:id', uuid);
  beamSpan.setAttribute('startid', '#' + id1);
  beamSpan.setAttribute('endid', '#' + id2);
  beamSpan.setAttribute('plist', v.selectedElements.map((e) => '#' + e).join(' '));
  let n1 = v.xmlDoc.querySelector("[*|id='" + id1 + "']");
  n1.closest('measure').appendChild(beamSpan);
  v.updateNotation = false;
  let sc = cm.getSearchCursor('xml:id="' + id1 + '"');
  if (sc.findNext()) {
    let p1 = utils.moveCursorToEndOfMeasure(cm, sc.from());
    cm.replaceRange(dutils.xmlToString(beamSpan) + '\n', cm.getCursor());
    cm.indentLine(p1.line, 'smart'); // TODO
    cm.indentLine(p1.line + 1, 'smart');
    cm.setSelection(p1);
  }
  v.selectedElements = [];
  v.selectedElements.push(uuid);
  v.lastNoteId = id2;
  addApplicationInfo(v, cm);
  v.updateData(cm, false, true);
  v.updateNotation = true; // update notation again
} // addBeamSpan()

// add octave element and modify notes inside selected elements
export function addOctaveElement(v, cm, disPlace = 'above', dis = '8') {
  v.loadXml(cm.getValue());
  if (v.selectedElements.length < 1) return;
  console.info('addOctaveElement selectedElements:', v.selectedElements);
  let id1 = v.selectedElements[0]; // xml:id string
  let id2 = v.selectedElements[v.selectedElements.length - 1];
  let n1 = v.xmlDoc.querySelector("[*|id='" + id1 + "']");
  // add control like element <octave @startid @endid @dis @dis.place>
  let octave = v.xmlDoc.createElementNS(dutils.meiNameSpace, 'octave');
  let uuid = utils.generateXmlId('octave', v.xmlIdStyle);
  octave.setAttributeNS(dutils.xmlNameSpace, 'xml:id', uuid);
  octave.setAttribute('startid', '#' + id1);
  octave.setAttribute('endid', '#' + id2);
  octave.setAttribute('dis', dis);
  octave.setAttribute('dis.place', disPlace);
  n1.closest('measure').appendChild(octave);
  // add it to the txtEdr
  v.updateNotation = false;
  // let checkPoint = buffer.createCheckpoint(); TODO
  let sc = cm.getSearchCursor('xml:id="' + id1 + '"');
  if (sc.findNext()) {
    let p1 = utils.moveCursorToEndOfMeasure(cm, sc.from());
    cm.replaceRange(dutils.xmlToString(octave) + '\n', cm.getCursor());
    cm.indentLine(p1.line, 'smart'); // TODO
    cm.indentLine(p1.line + 1, 'smart');
    cm.setSelection(p1);
  }
  // find plist and modify elements
  findAndModifyOctaveElements(cm, v.xmlDoc, id1, id2, disPlace, dis);
  // buffer.groupChangesSinceCheckpoint(checkPoint); // TODO
  v.selectedElements = [];
  v.selectedElements.push(uuid);
  v.lastNoteId = id2;
  addApplicationInfo(v, cm);
  v.updateData(cm, false, true);
  v.updateNotation = true; // update notation again
} // addOctaveElement()

// surround selected elements with a supplied element (and a responsibility
// statement from v.respId
export function addSuppliedElement(v, cm, attrName = 'none') {
  v.loadXml(cm.getValue());
  v.selectedElements = speed.filterElements(v.selectedElements, v.xmlDoc);
  v.selectedElements = utils.sortElementsByScorePosition(v.selectedElements);
  if (v.selectedElements.length < 1) return;
  v.updateNotation = false;

  let uuids = [];
  v.selectedElements.forEach((id) => {
    let el = v.xmlDoc.querySelector("[*|id='" + id + "']");
    if (!el) {
      console.warn('No such element in xml document: ' + id);
    } else {
      let parent = el.parentNode;

      // convert attrName to element and surround that
      if (attrName === 'artic' || attrName === 'accid') {
        if (!el.hasAttribute(attrName)) {
          const msg = 'No ' + attrName + ' attribute in element ' + el.nodeName + '.';
          console.log(msg);
          v.showAlert(msg, 'warning');
          return;
        }
        let attrValue = el.getAttribute(attrName);
        let attrEl = document.createElementNS(dutils.meiNameSpace, attrName);
        let uuid = mintSuppliedId(id, attrName);
        attrEl.setAttributeNS(dutils.xmlNameSpace, 'xml:id', uuid);
        attrEl.setAttribute(attrName, attrValue);
        el.removeAttribute(attrName);
        el.appendChild(attrEl);
        replaceInEditor(cm, el, true);
        cm.execCommand('indentAuto');
        parent = el;
        el = attrEl;
      }

      let sup = document.createElementNS(dutils.meiNameSpace, 'supplied');
      let uuid = mintSuppliedId(id, 'supplied');
      sup.setAttributeNS(dutils.xmlNameSpace, 'xml:id', uuid);
      if (v.respId) sup.setAttribute('resp', '#' + v.respId);
      parent.replaceChild(sup, el);
      sup.appendChild(el);
      replaceInEditor(cm, el, true, sup);
      cm.execCommand('indentAuto');
      uuids.push(uuid);
    }
  });
  // buffer.groupChangesSinceCheckpoint(checkPoint); // TODO
  v.selectedElements = [];
  uuids.forEach((u) => v.selectedElements.push(u));
  addApplicationInfo(v, cm);
  v.updateData(cm, false, true);
  v.updateNotation = true; // update notation again

  function mintSuppliedId(id, nodeName) {
    // follow the Mozarteum schema, keep numbers (for @o-sapov)
    let underscoreId = id.match(/_\d+$/);
    if (underscoreId) {
      return nodeName + underscoreId[0];
    }
    return utils.generateXmlId(nodeName, v.xmlIdStyle);
  }
} // addSuppliedElement()

export function addVerticalGroup(v, cm) {
  v.loadXml(cm.getValue());
  v.selectedElements = speed.filterElements(v.selectedElements, v.xmlDoc);
  if (v.selectedElements.length < 1) return;
  v.updateNotation = false;
  let value = 1;
  let existingValues = []; // search for existing vgrp values on SVG page
  // look to current page SVG dynam@vgrp, dir@vgrp, hairpin@vgrp, pedal@vgrp
  // and increment value if already taken
  document.querySelectorAll('g[data-vgrp]').forEach((e) => {
    let value = parseInt(e.getAttribute('data-vgrp'));
    if (existingValues.indexOf(value) < 0) existingValues.push(value);
  });
  while (existingValues.indexOf(value) >= 0) value++; // increment until unique
  v.selectedElements.forEach((id) => {
    let el = v.xmlDoc.querySelector("[*|id='" + id + "']");
    if (!el) {
      console.warn('No such element in xml document: ' + id);
    } else if (att.attVerticalGroup.includes(el.nodeName)) {
      let oldEl = el.cloneNode(true);
      el.setAttribute('vgrp', value);
      replaceInEditor(cm, oldEl, true, el);
      cm.execCommand('indentAuto');
    } else {
      console.warn('Vertical group not supported for ', el);
    }
  });
  addApplicationInfo(v, cm);
  v.updateData(cm, false, true);
  v.updateNotation = true; // update notation again
} // addVerticalGroup()

/**
 * Adds an application element to appInfo or updates its date, if already there
 * @param {Viewer} v
 * @param {object} cm
 */
export function addApplicationInfo(v, cm) {
  if (document.getElementById('addApplicationNote').checked) {
    let meiHead = v.xmlDoc.querySelector('meiHead');
    if (!meiHead) return false;
    let appList = v.xmlDoc.querySelectorAll('application');
    let encodingDesc, appInfo, application;
    let update = false;
    for (let a of appList) {
      appInfo = a.parentElement;
      encodingDesc = appInfo.parentElement;
      if (a.querySelector('name').textContent === 'mei-friend') {
        application = a; // update existing application element
        application.setAttribute('enddate', utils.toISOStringLocal(new Date()));
        application.setAttribute('version', version);
        const range = replaceInEditor(cm, application);
        for (let l = range.start.line; l <= range.end.line; l++) {
          cm.indentLine(l, 'smart');
        }
        update = true;
        break;
      }
    }
    if (update) return true;

    // application tree for mei-friend is created first time
    if (!encodingDesc) {
      encodingDesc = v.xmlDoc.createElementNS(dutils.meiNameSpace, 'encodingDesc');
      encodingDesc.setAttributeNS(dutils.xmlNameSpace, 'xml:id', utils.generateXmlId('encodingDesc', v.xmlIdStyle));
      meiHead.appendChild(encodingDesc);
    }
    if (!appInfo) {
      appInfo = v.xmlDoc.createElementNS(dutils.meiNameSpace, 'appInfo');
      appInfo.setAttributeNS(dutils.xmlNameSpace, 'xml:id', utils.generateXmlId('appInfo', v.xmlIdStyle));
      encodingDesc.appendChild(appInfo);
    }
    if (!application) {
      application = v.xmlDoc.createElementNS(dutils.meiNameSpace, 'application');
      application.setAttributeNS(dutils.xmlNameSpace, 'xml:id', utils.generateXmlId('application', v.xmlIdStyle));
      application.setAttribute('startdate', utils.toISOStringLocal(new Date()));
      application.setAttribute('version', version);
      let name = v.xmlDoc.createElementNS(dutils.meiNameSpace, 'name');
      name.textContent = 'mei-friend';
      name.setAttributeNS(dutils.xmlNameSpace, 'xml:id', utils.generateXmlId('name', v.xmlIdStyle));
      let p = v.xmlDoc.createElementNS(dutils.meiNameSpace, 'p');
      p.textContent = 'First edit by mei-friend ' + version + ', ' + versionDate + '.';
      p.setAttributeNS(dutils.xmlNameSpace, 'xml:id', utils.generateXmlId('p', v.xmlIdStyle));
      application.appendChild(name);
      application.appendChild(p);
      appInfo.appendChild(application);
    }
    // insert new element to editor
    const range = replaceInEditor(cm, meiHead);
    for (let l = range.start.line; l <= range.end.line; l++) {
      cm.indentLine(l, 'smart');
    }
    return true;
  }
} // addApplicationInfo()

// wrapper for cleaning superfluous @accid.ges attributes
export function cleanAccid(v, cm) {
  v.updateNotation = false;
  v.loadXml(cm.getValue(), true);
  utils.cleanAccid(v.xmlDoc, cm);
  v.updateNotation = true;
}

// wrapper for renumbering measure numberlike string
export function renumberMeasures(v, cm, change) {
  v.updateNotation = false;
  v.loadXml(cm.getValue(), true);
  utils.renumberMeasures(v, cm, 1, change);
  if (document.getElementById('showFacsimilePanel').checked) loadFacsimile(v.xmlDoc);
  addApplicationInfo(v, cm);
  v.updateData(cm, false, true);
  v.updateNotation = true;
} // renumberMeasures()

// function for adding/removing xml:ids in xmlDoc & reloading MEI into cm
export function manipulateXmlIds(v, cm, removeIds = false) {
  let startTime = Date.now();
  let report = { added: 0, removed: 0 };
  let skipList = []; // list of xml:ids that will not be removed

  v.updateNotation = false;
  v.loadXml(cm.getValue(), true);

  // start from these elements
  let selector = 'body > mdiv';
  let rootList = v.xmlDoc.querySelectorAll(selector);

  // determine skipList to securely remove ids
  if (removeIds) {
    rootList.forEach((e) => dig(e, true));
  }

  // manipulate xml tree starting from selector
  rootList.forEach((e) => dig(e));

  addApplicationInfo(v, cm);
  cm.setValue(new XMLSerializer().serializeToString(v.xmlDoc));
  v.updateData(cm, false, true);
  let msg;
  if (removeIds) {
    msg = report.removed + ' xml:ids removed from encoding, ';
    msg += skipList.length + ' xml:ids kept, because they are pointed to.';
  } else {
    msg = report.added + ' new xml:ids added to encoding';
    if (report.added > 0) {
      let el = document.getElementById('selectIdStyle');
      msg += ' (xml:id style: ' + el.value + '; e.g., "' + el.options[el.options.selectedIndex].title + '")';
    }
    msg += '.';
  }
  msg += ' (Processing time: ' + (Date.now() - startTime) / 1000 + ' s)';
  console.log(msg);
  v.showAlert(msg, 'success');
  v.updateNotation = true;

  // digs through xml tree recursively, when explore=true, just adding ids that are pointed to
  function dig(el, explore = false) {
    if (el.nodeType === Node.ELEMENT_NODE) {
      if (explore) {
        // just go through xml structure and search for pointing ids
        for (let attrName of att.dataURI) {
          let value = el.getAttribute(attrName);
          if (value) {
            // split value string by whitespace
            value.split(/[\s]+/).forEach((v) => skipList.push(utils.rmHash(v)));
          }
        }
      } else {
        if (!removeIds && !el.hasAttribute('xml:id')) {
          // add xml:id when missing
          el.setAttributeNS(dutils.xmlNameSpace, 'xml:id', utils.generateXmlId(el.nodeName, v.xmlIdStyle));
          report.added++;
        } else if (removeIds && el.hasAttribute('xml:id')) {
          // remove xml:id, unless pointed to
          if (!skipList.includes(el.getAttribute('xml:id'))) {
            el.removeAttribute('xml:id');
            report.removed++;
          }
        }
      }
      // recursively through the xml tree
      el.childNodes.forEach((e) => dig(e, explore));
    }
  }
} // manipulateXmlIds()

/**
 * Add zone element in editor (called from source-imager.js),
 * places it
 * @param {Viewer} v
 * @param {CodeMirror} cm
 * @param {object} rect
 * @param {boolean} addMeasure
 * @returns
 */
export function addZone(v, cm, rect, addMeasure = true) {
  v.updateNotation = false;
  // get current element id and nodeName from editor
  let selectedId = utils.getElementIdAtCursor(cm);
  let selectedElement = v.xmlDoc.querySelector('[*|id=' + selectedId + ']');
  if (!selectedElement) {
    v.updateNotation = true;
    return false;
  }

  // create zone with all attributes
  let zone = v.xmlDoc.createElementNS(dutils.meiNameSpace, 'zone');
  let uuid = utils.generateXmlId('zone', v.xmlIdStyle);
  zone.setAttributeNS(dutils.xmlNameSpace, 'xml:id', uuid);
  let x = Math.round(rect.getAttribute('x'));
  let y = Math.round(rect.getAttribute('y'));
  let width = Math.round(rect.getAttribute('width'));
  let height = Math.round(rect.getAttribute('height'));
  rect.setAttribute('id', uuid);
  zone.setAttribute('type', addMeasure ? 'measure' : selectedElement.nodeName);
  zone.setAttribute('ulx', x);
  zone.setAttribute('uly', y);
  zone.setAttribute('lrx', x + width);
  zone.setAttribute('lry', y + height);

  // check if current element a zone
  if (addMeasure && selectedElement.nodeName === 'zone' && selectedElement.parentElement.nodeName === 'surface') {
    // add zone to surface
    cm.execCommand('goLineEnd');
    cm.replaceRange('\n' + dutils.xmlToString(zone), cm.getCursor());
    cm.execCommand('indentAuto');
    let prevMeas = v.xmlDoc.querySelector('[facs="#' + selectedElement.getAttribute('xml:id') + '"]');
    if (prevMeas.nodeName !== 'measure') {
      // try to find closest measure element
      let m = prevMeas.closest('measure');
      if (!m) return false; // and stop, if unsuccessful
      prevMeas = m;
    }

    // Create new measure element
    let newMeas = v.xmlDoc.createElementNS(dutils.meiNameSpace, 'measure');
    newMeas.setAttributeNS(dutils.xmlNameSpace, 'xml:id', utils.generateXmlId('measure', v.xmlIdStyle));
    newMeas.setAttribute('n', prevMeas.getAttribute('n') + '-new');
    newMeas.setAttribute('facs', '#' + uuid);

    // add to DOM
    prevMeas.after(newMeas);

    // navigate to prev measure element
    utils.setCursorToId(cm, prevMeas.getAttribute('xml:id'));
    cm.execCommand('toMatchingTag');
    cm.execCommand('goLineEnd');
    cm.replaceRange('\n' + dutils.xmlToString(newMeas), cm.getCursor());
    cm.execCommand('indentAuto');
    utils.setCursorToId(cm, uuid);

    // updating
    loadFacsimile(v.xmlDoc);
    addApplicationInfo(v, cm);
    v.updateData(cm, false, false);
    console.log('Editor: new zone ' + uuid + 'added.', rect);
    v.updateNotation = true;
    return true;

    // only add zone and a @facs for the selected element
  } else if (!addMeasure && att.attFacsimile.includes(selectedElement.nodeName)) {
    // find pertinent zone in surface for inserting new zone
    let facs = v.xmlDoc.querySelectorAll('[facs],[*|id="' + selectedId + '"');
    let i = Array.from(facs).findIndex((n) => n.isEqualNode(selectedElement));
    let referenceNodeId = utils.rmHash(facs[i === 0 ? i + 1 : i - 1].getAttribute('facs'));
    let referenceNode = v.xmlDoc.querySelector('[*|id="' + referenceNodeId + '"');
    console.log('addZone() referenceNode: ', referenceNode);
    if (!referenceNode) {
      console.log('addZone(): no reference element found with xml:id="' + referenceNodeId + '"');
      v.updateNotation = true;
      return false;
    }
    if (referenceNode.nodeName === 'surface') {
      referenceNode.appendChild(zone);
    } else {
      referenceNode.after(zone);
    }

    // add zone to editor
    utils.setCursorToId(cm, referenceNodeId);
    cm.execCommand('toMatchingTag');
    if (referenceNode.nodeName !== 'surface') {
      cm.execCommand('goLineEnd');
      cm.replaceRange('\n' + dutils.xmlToString(zone), cm.getCursor());
      cm.execCommand('indentAuto');
    } else {
      cm.execCommand('goLineStart');
      cm.replaceRange(dutils.xmlToString(zone), cm.getCursor());
      cm.execCommand('indentAuto');
      cm.execCommand('newlineAndIndent');
    }

    // add @facs to selected element
    selectedElement.setAttribute('facs', '#' + uuid);
    replaceInEditor(cm, selectedElement);
    utils.setCursorToId(cm, uuid);

    // updating
    loadFacsimile(v.xmlDoc);
    addApplicationInfo(v, cm);
    v.updateData(cm, false, false);
    console.log('Editor: new zone ' + uuid + 'added.', rect);
    v.updateNotation = true;
    return true;
  } else {
    v.updateNotation = true;
    return false;
  }
} // addZone()

// remove zone in editor, called from editor.js
export function removeZone(v, cm, zone, removeMeasure = false) {
  if (!zone) return;
  removeInEditor(cm, zone);
  let rect = document.querySelector('rect[id="' + zone.getAttribute('xml:id') + '"]');
  if (rect) rect.parentElement.removeChild(rect);
  let txt = document.querySelector('text[id="' + zone.getAttribute('xml:id') + '"]');
  if (txt) txt.parentElement.removeChild(txt);
  // find elements referring to this zone id via @facs and delete them
  let ms = v.xmlDoc.querySelectorAll('[facs="#' + zone.getAttribute('xml:id') + '"]');
  ms.forEach((e) => {
    if (removeMeasure) {
      removeInEditor(cm, e);
      e.remove();
    } else {
      e.removeAttribute('facs');
      replaceInEditor(cm, e);
    }
  });
  loadFacsimile(v.xmlDoc);
  addApplicationInfo(v, cm);
  v.updateData(cm, false, false);
} // removeZone()

/**
 * Adds a facsimile element to DOM and editor,
 * with a surface element for each page beginning <pb> to which
 * a @facs attribute is added referencing the surface element.
 * Additionally, each surface elements will be added a <graphic>
 * element.
 * If the facsimile element exists, it will check all
 * surface elements and the pb@facs references and add them if
 * necessary.
 * @param {object} v
 * @param {object} cm
 */
export function addFacsimile(v, cm) {
  v.updateNotation = false;
  let facsimile = v.xmlDoc.querySelector('facsimile');
  let facsimileId;
  if (facsimile) {
    facsimileId = facsimile.getAttribute('xml:id');
    this.removeInEditor(cm, facsimile);
  }
  if (!facsimile) {
    facsimile = v.xmlDoc.createElementNS(dutils.meiNameSpace, 'facsimile');
    facsimileId = utils.generateXmlId('facsimile', v.xmlIdStyle);
    facsimile.setAttributeNS(dutils.xmlNameSpace, 'xml:id', facsimileId);
    v.xmlDoc.querySelector('body').before(facsimile);
  }
  v.xmlDoc.querySelectorAll('pb').forEach((pb, p) => {
    let pbFacs = utils.rmHash(pb.getAttribute('facs'));
    let surface = v.xmlDoc.querySelector('surface[*|id="' + pbFacs + '"]');
    let surfaceId;
    if (surface) {
      surfaceId = surface.getAttribute('xml:id');
    } else {
      surface = v.xmlDoc.createElementNS(dutils.meiNameSpace, 'surface');
      surfaceId = utils.generateXmlId('surface', v.xmlIdStyle);
      surface.setAttributeNS(dutils.xmlNameSpace, 'xml:id', surfaceId);
      facsimile.appendChild(surface);
      // update pb elements in DOM and in editor
      pb.setAttribute('facs', '#' + surfaceId);
      this.replaceInEditor(cm, pb);
    }
    let graphic = surface.querySelector('graphic');
    if (!graphic) {
      graphic = v.xmlDoc.createElementNS(dutils.meiNameSpace, 'graphic');
      let graphicId = utils.generateXmlId('graphic', v.xmlIdStyle);
      graphic.setAttributeNS(dutils.xmlNameSpace, 'xml:id', graphicId);
      graphic.setAttribute('target', 'Page-' + (p + 1)); // dummy values
      graphic.setAttribute('width', '0');
      graphic.setAttribute('height', '0');
      surface.appendChild(graphic);
    }
  });

  // add to editor
  let c = cm.getSearchCursor('<body');
  let p1;
  if (c.findNext()) {
    p1 = c.from();
    cm.setCursor(p1);
  }
  cm.replaceRange(dutils.xmlToString(facsimile) + '\n', cm.getCursor());
  for (let l = p1.line; l <= cm.getCursor().line; l++) cm.indentLine(l, 'smart');
  utils.setCursorToId(cm, facsimileId);

  loadFacsimile(v.xmlDoc);
  addApplicationInfo(v, cm);
  v.updateData(cm, false, false);
  console.log('Editor: new facsimile added', facsimile);
  v.updateNotation = true;
} // addFacsimile()

// find xmlNode in textBuffer and remove it (including empty line)
export function removeInEditor(cm, xmlNode) {
  let itemId = xmlNode.getAttribute('xml:id');
  let searchSelfClosing = '(?:<' + xmlNode.nodeName + `)(\\s+?)([^>]*?)(?:xml:id=["']` + itemId + `['"])([^>]*?)(?:/>)`;
  let sc = cm.getSearchCursor(new RegExp(searchSelfClosing));
  if (sc.findNext()) {
    console.info('removeInEditor() self closing from: ', sc.from());
    console.info('removeInEditor() self closing to: ', sc.to());
  } else {
    let searchFullElement =
      '(?:<' +
      xmlNode.nodeName +
      `)(\\s+?)([^>]*?)(?:xml:id=["']` +
      itemId +
      `["'])([\\s\\S]*?)(?:</` +
      xmlNode.nodeName +
      '[ ]*?>)';
    sc = cm.getSearchCursor(new RegExp(searchFullElement));
    if (sc.findNext()) {
      console.info('removeInEditor() full element from: ', sc.from());
      console.info('removeInEditor() full element to: ', sc.to());
    }
  }
  if (sc.atOccurrence) {
    sc.replace('');
    let c = cm.getCursor();
    for (let l = sc.from().line; l <= sc.to().line; l++) {
      if (isEmpty(cm.getLine(l))) {
        cm.setCursor(l, c.ch);
        cm.execCommand('deleteLine');
      }
    }
  } else console.info('removeInEditor(): nothing removed for ' + itemId + '.');
}

function isEmpty(str) {
  return !/\S/g.test(str);
}

// find xmlNode in textBuffer and replace it with new serialized content
export function replaceInEditor(cm, xmlNode, select = false, newNode = null) {
  let newMEI = newNode ? dutils.xmlToString(newNode) : dutils.xmlToString(xmlNode);
  // search in buffer
  let itemId = xmlNode.getAttribute('xml:id');
  let xmlIdCheck = '';
  if (itemId) xmlIdCheck = `(\\s+?)([^>]*?)(?:xml:id=["']` + itemId + `['"])`;
  let searchSelfClosing = '(?:<' + xmlNode.nodeName + `)` + xmlIdCheck + `([^>]*?)(?:/>)`;
  // console.info('searchSelfClosing: ' + searchSelfClosing);
  let sc = cm.getSearchCursor(new RegExp(searchSelfClosing));
  if (sc.findNext()) {
    sc.replace(newMEI);
  } else {
    let searchFullElement =
      '(?:<' + xmlNode.nodeName + `)` + xmlIdCheck + `([\\s\\S]*?)(?:</` + xmlNode.nodeName + '[ ]*?>)';
    sc = cm.getSearchCursor(new RegExp(searchFullElement));
    if (sc.findNext()) sc.replace(newMEI);
    // console.info('searchFullElement: ' + searchFullElement);
  }
  if (!sc.atOccurrence) {
    console.info('replaceInEditor(): nothing replaced for ' + itemId + '.');
    return {
      start: -1,
      end: -1,
    };
  } else if (select) {
    sc = cm.getSearchCursor(newMEI);
    if (sc.findNext()) {
      let c = cm.getCursor();
      for (let l = sc.from().line; l <= sc.to().line; l++) {
        if (isEmpty(cm.getLine(l))) {
          cm.setCursor(l, c.ch);
          cm.execCommand('deleteLine');
        }
      }
      cm.setSelection(sc.from(), sc.to());
    }
  }
  return {
    start: sc.from(),
    end: sc.to(),
  };
}

// ############################################################################
// # (mostly) private functions                                               #
// ############################################################################

function toggleArticForNote(v, note, artic) {
  note = utils.attrAsElements(note);
  let articChildren;
  let add = false;
  let uuid;
  // check if articulations exist, as elements or attributes
  if (note.hasChildNodes() && (articChildren = note.querySelectorAll('artic')).length > 0) {
    // console.info('toggleArtic check children: ', articChildren);
    for (let articChild of articChildren) {
      let existingArtic = articChild.getAttribute('artic');
      if (existingArtic === artic) {
        articChild.remove();
        add = false;
      } else {
        add = true;
      }
    }
  } else {
    add = true;
  }
  if (add) {
    // add artic as element
    let articElement = document.createElementNS(dutils.meiNameSpace, 'artic');
    uuid = utils.generateXmlId('artic', v.xmlIdStyle);
    articElement.setAttributeNS(dutils.xmlNameSpace, 'xml:id', uuid);
    articElement.setAttribute('artic', artic);
    note.appendChild(articElement);
  }
  // console.info('modified element: ', note);
  return uuid;
}

function pitchMover(el, deltaPitch) {
  let oct = 4;
  let pname = 'c';
  let o;
  let p;
  if (['note'].includes(el.nodeName)) {
    o = 'oct';
    p = 'pname';
  } else if (['rest', 'mRest', 'multiRest'].includes(el.nodeName)) {
    o = 'oloc';
    p = 'ploc';
  }
  if (el.hasAttribute(o)) oct = parseInt(el.getAttribute(o));
  if (el.hasAttribute(p)) pname = el.getAttribute(p);
  let pi = att.pnames.indexOf(pname) + deltaPitch;
  if (pi > att.pnames.length - 1) {
    pi -= att.pnames.length;
    oct++;
  } else if (pi < 0) {
    pi += att.pnames.length;
    oct--;
  }
  el.setAttribute(o, oct);
  el.setAttribute(p, att.pnames[pi]);
  return el;
}

function staffMover(cm, el, upwards) {
  let staff = el.closest('staff');
  let staffNo = -1;
  if (staff) staffNo = parseInt(staff.getAttribute('n'));
  // check existing staff attribute
  let staffNoAttr = -1;
  if (el.hasAttribute('staff')) {
    staffNoAttr = parseInt(el.getAttribute('staff'));
  }
  let newStaffNo = -1;
  if (upwards) {
    if (staffNoAttr > 0) newStaffNo = staffNoAttr - 1;
    else newStaffNo = staffNo - 1;
  } else {
    // downwards
    if (staffNoAttr > 0) newStaffNo = staffNoAttr + 1;
    else newStaffNo = staffNo + 1;
  }
  if (staffNo === newStaffNo) el.removeAttribute('staff');
  else el.setAttribute('staff', newStaffNo);
  replaceInEditor(cm, el);
}

// find all notes between two ids in the same staff and set @oct.ges and
// modify @oct with deltaOct (1,-1, 2,...);
// or, if set=false: remove @oct.ges and reset @oct
function findAndModifyOctaveElements(cm, xmlDoc, id1, id2, disPlace, dis, add = true) {
  let deltaOct = (parseInt(dis) - 1) / 7;
  if (disPlace === 'below') deltaOct *= -1; // normal logic: minus 1 when below
  if (add) deltaOct *= -1; // inverse logic: minus when adding above 8
  let n1 = xmlDoc.querySelector("[*|id='" + id1 + "']");
  let st1 = n1.closest('staff');
  if (st1) {
    let staffNumber = st1.getAttribute('n');
    // find all staves with the same @n attribute
    let allStaves = xmlDoc.querySelectorAll("staff[n='" + staffNumber + "']");
    let staffFound = false;
    let noteFound = false;
    // find staff with id1 in it
    for (let st of allStaves) {
      let child1 = st.querySelector("[*|id='" + id1 + "']");
      if (child1) staffFound = true;
      if (!child1 && !staffFound) {
        continue;
      }
      if (staffFound) {
        // select notes after
        let notes = st.getElementsByTagName('note');
        for (let n of notes) {
          if (n.getAttribute('xml:id') === id1) {
            noteFound = true;
          }
          if (noteFound) {
            let oct = parseInt(n.getAttribute('oct'));
            if (add) {
              n.setAttribute('oct.ges', oct);
            } else {
              // remove
              n.removeAttribute('oct.ges');
            }
            n.setAttribute('oct', oct + deltaOct);
            replaceInEditor(cm, n);
          }
          if (n.getAttribute('xml:id') === id2) {
            return;
          }
        }
      }
    }
  }
  return;
} // findAndModifyOctaveElements()

/**
 * Determines an array of staff numbers for a given element that spans
 * the relevant staff group that the element is inside.
 * @param {Viewer} v
 * @param {Element} element
 * @returns {Array[]} staffNumbers
 */
function getStaffNumbersForClosestStaffGroup(v, element) {
  if (!element) return null;
  let staffNumber;
  if (element.hasAttribute('startid')) {
    const startElement = v.xmlDoc.querySelector('[*|id=' + utils.rmHash(element.getAttribute('startid')) + ']');
    if (startElement) {
      staffNumber = startElement.closest('staff')?.getAttribute('n');
    }
  } else if (element.hasAttribute('staff') && element.hasAttribute('n')) {
    staffNumber = element.getAttribute('n');
  }
  if (staffNumber) {
    const staffList = v.xmlDoc.querySelector('scoreDef')?.querySelectorAll('staffDef');
    let staff;
    staffList.forEach((st) => {
      if (st.getAttribute('n') === staffNumber) {
        staff = st;
      }
    });
    if (staff) {
      const staffGroup = staff.closest('staffGrp');
      if (staffGroup) {
        let staffNumbers = [];
        staffGroup.querySelectorAll('staffDef').forEach((st) => {
          const n = st.getAttribute('n');
          if (n) staffNumbers.push(n);
        });
        return staffNumbers;
      }
    }
    return [];
  }
} // findClosestStaffGroup()
