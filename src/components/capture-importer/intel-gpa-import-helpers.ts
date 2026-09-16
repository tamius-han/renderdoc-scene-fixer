import { calculateDistortion } from '../../mesh-tools/calculator';
import { parseOBJ } from '../../parsers/obj';
import { objToGeometryArrays } from '../../scene/mesh-builder';
import { FileInfo } from '../../types/file-info.interface';
import { IntelGPADropzone } from './intel-gpa-dropzone.type';

const landmarkSources = ['landmark-source', 'ls', 'landmark-src'];
const landmarkOutputs = ['landmark-output', 'lo', 'landmark-out'];
/**
 * Guesses the IntelGPA import target based on the filename.
 * Only used when file is dragged to the global dropzone.
 * @param entry
 * @returns
 */
export function guessIntelGPAImportTargetFromFilename(entry: FileInfo): IntelGPADropzone | undefined {
  const filename = entry.path.toLowerCase().split('/')?.pop()?.split('.obj')[0];

  if (!filename) {
    return undefined;
  }
  if (landmarkSources.includes(filename)) {
    return 'landmark-source';
  }
  if (landmarkOutputs.includes(filename)) {
    return 'landmark-output';
  }
  return 'scene';
}

/**
 * Takes files we dropped into the Intel GPA input dropzone and guess their roles based on name.
 * If roles cannot be determined from names, they will be identified based on their content later.
 * @param entries
 * @returns
 */
export function guessIntelGPAImportTargetsFromFilenames(entries: FileInfo[]): { [key in IntelGPADropzone]: FileInfo } {
  const droppedFiles = entries.map(entry => ({
    entry,
    target: guessIntelGPAImportTargetFromFilename(entry)
  }));

  const mappedOutput: { [key in IntelGPADropzone]: FileInfo } = {} as any;    // 'as any' is there to shut up ts about empty object, we know it's gonna get filled

  const sourceIndex = droppedFiles.findIndex(f => f.target === 'landmark-source');
  if (sourceIndex !== -1) {
    mappedOutput['landmark-source'] = droppedFiles[sourceIndex].entry;
    droppedFiles.splice(sourceIndex, 1);
  }
  const outputIndex = droppedFiles.findIndex(f => f.target === 'landmark-output');
  if (outputIndex !== -1) {
    mappedOutput['landmark-output'] = droppedFiles[outputIndex].entry;
    droppedFiles.splice(outputIndex, 1);
  }

  /**
   * If everything is right, the only thing left in the droppedFiles array should be the scene file.
   * The first thing in the droppedFiles thus goes into the 'scene' slot.
   * If there are any remaining files, that means either 'landmark-source' or 'landmark-output' was
   * not correctly identified. However, since we later identify files based on their content, we just
   * chunk any remaining files into whatever slots are unfilled and call it a day.
   */
  const keyOrder = ['scene', 'landmark-output', 'landmark-source'];
  for (let i = 0; i < droppedFiles.length; i++) {
    for (let j = 0; j < keyOrder.length; j++) {
      const key = keyOrder[j] as IntelGPADropzone;
      if (!mappedOutput[key] && droppedFiles[i].target === key) {
        mappedOutput[key] = droppedFiles[i].entry;
        break;
      }
    }
  }

  return mappedOutput;
}

/**
 * Takes three files from intel gpa export and identifies their roles.
 * @param landmarkSourceFile we suspect this is landmark source geometry
 * @param landmarkOutputFile we suspect this is landmark output
 * @param sceneFile we suspect this is scene output
 * @returns correct file-role mapping, or undefined if we couldn't determine which file belongs to which role
 */
export async function identifyIntelGPAImport(landmarkSourceFile: FileInfo, landmarkOutputFile: FileInfo, sceneFile: FileInfo) {
  const landmarkSourceGeometry = parseOBJ(await landmarkSourceFile.file.text());
  const landmarkOutputGeometry = parseOBJ(await landmarkOutputFile.file.text());
  const sceneGeometry = parseOBJ(await sceneFile.file.text());

  if (
    landmarkSourceGeometry.positions.length === landmarkOutputGeometry.positions.length &&
    landmarkSourceGeometry.faces.length === landmarkOutputGeometry.faces.length
  ) {
    const geometryData = objToGeometryArrays(landmarkSourceGeometry);
    const previewGeometryData = objToGeometryArrays(landmarkOutputGeometry);

    const distortion = calculateDistortion({geometryData, previewGeometryData});

    // TODO: check which file is source and which one is output, they could be reversed

    return {
      'landmark-source': {
        file: landmarkSourceFile,
        obj: landmarkSourceGeometry
      },
      'landmark-output': {
        file: landmarkOutputFile,
        obj: landmarkOutputGeometry
      },
      'scene': {
        file: sceneFile,
        obj: sceneGeometry
      },
      distortion
    }
  } else if (
    landmarkSourceGeometry.positions.length === sceneGeometry.positions.length
    && landmarkSourceGeometry.faces.length === sceneGeometry.faces.length
    && landmarkOutputGeometry.positions.length !== sceneGeometry.positions.length
    && landmarkOutputGeometry.faces.length !== sceneGeometry.faces.length
  ) {
    return identifyIntelGPAImport(landmarkSourceFile, sceneFile, landmarkOutputFile);
  } else if (
    landmarkOutputGeometry.positions.length === sceneGeometry.positions.length
    && landmarkOutputGeometry.faces.length === sceneGeometry.faces.length
    && landmarkSourceGeometry.positions.length !== sceneGeometry.positions.length
    && landmarkSourceGeometry.faces.length !== sceneGeometry.faces.length
  ) {
    return identifyIntelGPAImport(landmarkOutputFile, sceneFile, landmarkSourceFile);
  }

  return undefined;
}
