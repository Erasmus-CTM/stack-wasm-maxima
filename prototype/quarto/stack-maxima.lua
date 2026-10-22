-- SPDX-License-Identifier: AGPL-3.0-or-later
-- An authoring alias only: CTM's pinned stack-sympy filter still renders cards.
local function convert(div)
  if not div.classes:includes('stack-maxima') then return nil end
  -- Markdown parses option lines as one paragraph with soft line breaks.
  -- stringify() turns those breaks into spaces, which merges every option
  -- into the file value. Preserve them before handing CTM its code block.
  local lines = div:walk({
    SoftBreak = function() return pandoc.Str('\n') end,
    LineBreak = function() return pandoc.Str('\n') end
  })
  local text = pandoc.utils.stringify(lines.content)
  for line in (text .. '\n'):gmatch('([^\r\n]*)\n') do
    assert(not line:match('%S') or line:match('^#|%s*[%w_-]+:%s*'),
      'stack-maxima: only #| key: value lines are allowed inside the block')
  end
  local classes = pandoc.List({'stack-question'})
  for _, class in ipairs(div.classes) do
    if class ~= 'stack-maxima' then classes:insert(class) end
  end
  return pandoc.CodeBlock(text, pandoc.Attr(div.identifier, classes, div.attributes))
end

return {{Pandoc = function(doc)
  local maxima = false
  doc = doc:walk({Div = function(div)
    if div.classes:includes('stack-maxima') then maxima = true end
    return convert(div)
  end})
  if maxima then
    -- The generated demo's pages live one directory below its common assets.
    -- This descriptor is read by the materialized generic frontend seam.
    local config = '<script>window.CTMStackBackend={workerURL:"../backend/worker.js",label:"Maxima",loadTimeout:240000};</script>'
    doc.blocks:insert(1, pandoc.RawBlock('html', config))
  end
  return doc
end}}
