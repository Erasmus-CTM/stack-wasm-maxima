// Use the pinned upstream transport and runtime unchanged.
importScripts('/maxima_thread.js');
const upstreamStart = self.onmessage;
self.onmessage = event => {
  const { files, buffers } = event.data;
  Module.preRun.push(function () {
    for (const directory of ['/ctm', '/ctm/tmp', '/ctm/plots', '/ctm/obj',
      '/ctm/moodle-qtype_stack-master/tmp']) FS.mkdirTree(directory);
    for (const file of files) {
      const path = '/ctm/moodle-qtype_stack-master/' + file.path;
      FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
      FS.writeFile(path, new TextEncoder().encode(file.content));
    }
  });
  try { upstreamStart({ data: buffers }); }
  catch (error) { self.postMessage({ type: 'm1-error', error: String(error.stack || error) }); }
};
