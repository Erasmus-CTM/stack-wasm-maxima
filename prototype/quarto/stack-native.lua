-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Display already prepared native plans through the shared CTM frontend.
local installed = false

local function read(path)
  local file, reason = io.open(path, 'rb')
  assert(file, 'stack-native: could not read ' .. path .. ': ' .. tostring(reason))
  local contents = file:read('*a')
  file:close()
  return contents
end

local function setup()
  if installed then return end
  installed = true
  local root = assert(quarto.project.directory, 'stack-native requires the repository Quarto project')
  local extension = pandoc.path.join({root, '_extensions', 'stack-sympy'})
  local ctm = dofile(pandoc.path.join({extension, 'ctm-bootstrap.lua'}))('stack-sympy')
  assert(ctm.checkers, 'stack-native requires the shared CTM checker descriptor')
  ctm.checkers.require('stack-sympy', 1)
  ctm.runtime.use()
  ctm.checkers.use('stack')
  local version = read(pandoc.path.join({extension, '_extension.yml'})):match('\nversion:%s*([%w%.%-]+)') or '0.3.0'
  quarto.doc.add_html_dependency({name='stack-sympy', version=version,
    scripts={{path=pandoc.path.join({extension,'vendor','matrix-input.js'}),afterBody=true},
             {path=pandoc.path.join({extension,'stack-sympy.js'}),afterBody=true}},
    stylesheets={pandoc.path.join({extension,'vendor','matrix-input.css'}),pandoc.path.join({extension,'stack-sympy.css'})},
    resources={{name='worker.js',path=pandoc.path.join({extension,'worker.js'})}}})
  quarto.doc.add_html_dependency({name='ctm-stack-jsxgraph',version='1',
    scripts={{path=pandoc.path.join({root,'jsxgraph','host.js'}),afterBody=true}}})
end

return {{Pandoc=function(doc)
  local native = false
  doc = doc:walk({Div=function(div)
    if not div.classes:includes('stack-native') then return nil end
    assert(quarto.doc.is_format('html:js'), 'stack-native questions require interactive HTML output')
    local id = div.identifier
    assert(id:match('^[A-Za-z][A-Za-z0-9_-]*$'), 'stack-native requires a stable question identifier')
    local lines = div:walk({SoftBreak=function() return pandoc.Str('\n') end,LineBreak=function() return pandoc.Str('\n') end})
    local text = pandoc.utils.stringify(lines.content)
    local prepared = nil
    for line in (text .. '\n'):gmatch('([^\r\n]*)\n') do
      if line:match('%S') then
        local value = line:match('^#|%s*prepared:%s*([A-Za-z][A-Za-z0-9_-]*)%s*$')
        assert(value and not prepared, 'stack-native accepts exactly one #| prepared: identifier option')
        prepared = value
      end
    end
    assert(prepared == id, 'stack-native prepared identity must match the authored identifier')
    setup()
    local fragment = read(pandoc.path.join({quarto.project.directory,'.native-prepared',id .. '.html'}))
    assert(fragment:find('data%-stack%-id="' .. id .. '"'), 'stack-native fragment identity mismatch')
    native = true
    return pandoc.RawBlock('html', fragment)
  end})
  if native then
    doc.blocks:insert(1,pandoc.RawBlock('html','<script>window.CTMStackBackends=window.CTMStackBackends||{};window.CTMStackBackends["maxima-native"]={workerURL:"../native/backend-worker.js",label:"Native Maxima",loadTimeout:240000};document.addEventListener("DOMContentLoaded",function(){window.CTMStackJSXGraph.install(document);},{once:true});</script>'))
  end
  return doc
end}}
