"""
Minimal FBX binary parser — dumps bone rest poses and first animation frame
for Mixamo FBX files.
"""
import struct, sys, re
from pathlib import Path

FBX = Path(sys.argv[1] if len(sys.argv) > 1 else
    "/home/fennsorenn/projects/vspark/packages/backend/uploads/ca2b5c03-53b7-4a2c-9357-739cd57a2c4e.fbx")

data = FBX.read_bytes()

# ── FBX binary: magic + version ─────────────────────────────────────────────
MAGIC = b"Kaydara FBX Binary  \x00\x1a\x00"
assert data[:len(MAGIC)] == MAGIC, "Not a binary FBX"
version = struct.unpack_from("<I", data, len(MAGIC))[0]
print(f"FBX version: {version}  ({FBX.name})\n")

IS_64 = version >= 7500

def read_node(buf, offset):
    """Parse one FBX record node. Returns (name, props, children, next_offset)."""
    if IS_64:
        end, n_props, prop_list_len = struct.unpack_from("<QQQ", buf, offset)
        name_len = struct.unpack_from("<B", buf, offset + 25)[0]
        name = buf[offset+26 : offset+26+name_len].decode("latin-1")
        offset += 26 + name_len
    else:
        end, n_props, prop_list_len = struct.unpack_from("<III", buf, offset)
        name_len = struct.unpack_from("<B", buf, offset + 13)[0]
        name = buf[offset+14 : offset+14+name_len].decode("latin-1")
        offset += 14 + name_len

    if end == 0:
        return None, offset

    props = []
    for _ in range(n_props):
        type_code = chr(buf[offset]); offset += 1
        if type_code in "YCBIF":
            sizes = {"Y":2,"C":1,"B":1,"I":4,"F":4}
            fmts  = {"Y":"h","C":"?","B":"B","I":"i","F":"f"}
            v = struct.unpack_from(f"<{fmts[type_code]}", buf, offset)[0]
            offset += sizes[type_code]
            props.append(v)
        elif type_code == "D":
            v = struct.unpack_from("<d", buf, offset)[0]; offset += 8
            props.append(v)
        elif type_code == "L":
            v = struct.unpack_from("<q", buf, offset)[0]; offset += 8
            props.append(v)
        elif type_code == "S":
            length = struct.unpack_from("<I", buf, offset)[0]; offset += 4
            s = buf[offset:offset+length].decode("latin-1"); offset += length
            props.append(s)
        elif type_code == "R":
            length = struct.unpack_from("<I", buf, offset)[0]; offset += 4
            offset += length
            props.append(b"<raw>")
        elif type_code in "fdilb":
            enc_count = struct.unpack_from("<I", buf, offset)[0]; offset += 4
            enc       = struct.unpack_from("<I", buf, offset)[0]; offset += 4
            comp_len  = struct.unpack_from("<I", buf, offset)[0]; offset += 4
            arr_data  = buf[offset:offset+comp_len]; offset += comp_len
            if enc == 1:
                import zlib; arr_data = zlib.decompress(arr_data)
            item_size = {"f":4,"d":8,"i":4,"l":8,"b":1}[type_code]
            fmt_char  = {"f":"f","d":"d","i":"i","l":"q","b":"B"}[type_code]
            count = len(arr_data) // item_size
            arr = struct.unpack_from(f"<{count}{fmt_char}", arr_data)
            props.append(arr)
        else:
            break  # unknown type — stop

    children = []
    while offset < end - (25 if IS_64 else 13):
        child, offset = read_node(buf, offset)
        if child is None:
            break
        children.append(child)

    return (name, props, children), end


def parse_top(buf):
    offset = len(MAGIC) + 4  # skip magic + version
    nodes = []
    while offset < len(buf) - (25 if IS_64 else 13):
        node, offset = read_node(buf, offset)
        if node is None:
            break
        nodes.append(node)
    return nodes


def find_all(nodes, *path):
    """Yield all nodes matching a path of names."""
    if not path:
        yield from nodes
        return
    for n in nodes:
        name, props, children = n
        if name == path[0]:
            if len(path) == 1:
                yield n
            else:
                yield from find_all(children, *path[1:])


top = parse_top(data)

# ── GlobalSettings ───────────────────────────────────────────────────────────
print("=== GlobalSettings ===")
axes = {"UpAxis":None,"UpAxisSign":None,"FrontAxis":None,"FrontAxisSign":None,
        "CoordAxis":None,"CoordAxisSign":None,"UnitScaleFactor":None}
for gs in find_all(top, "GlobalSettings"):
    for prop in find_all(gs[2], "Properties70"):
        for p in prop[2]:
            if p[0] == "P" and p[1][0] in axes:
                axes[p[1][0]] = p[1][3] if len(p[1]) > 3 else None
axis_names = ["X","Y","Z"]
print(f"  UpAxis      : {axis_names[axes['UpAxis'] or 1]} × {axes['UpAxisSign']}")
print(f"  FrontAxis   : {axis_names[axes['FrontAxis'] or 2]} × {axes['FrontAxisSign']}")
print(f"  CoordAxis   : {axis_names[axes['CoordAxis'] or 0]} × {axes['CoordAxisSign']}")
print(f"  UnitScale   : {axes['UnitScaleFactor']} cm")
print()

# ── Collect Model nodes (bones) ──────────────────────────────────────────────
# Each Model has Properties70 with Lcl Translation, Lcl Rotation, PreRotation
bone_info = {}  # name → {pre_rot, lcl_rot, lcl_trans}

for model in find_all(top, "Objects"):
    for m in find_all(model[2], "Model"):
        if len(m[1]) < 2: continue
        raw_name = m[1][0] if isinstance(m[1][0], str) else ""
        # Mixamo names look like "mixamorigHips\x00\x01LimbNode"
        bone_name = raw_name.split("\x00")[0].strip()
        if not bone_name.startswith("mixamorig"):
            continue
        info = {"pre_rot": None, "lcl_rot": None, "lcl_trans": None}
        for prop in find_all(m[2], "Properties70"):
            for p in prop[2]:
                if p[0] != "P": continue
                pname = p[1][0] if p[1] else ""
                vals  = p[1][4:7] if len(p[1]) >= 7 else None
                if pname == "PreRotation" and vals:
                    info["pre_rot"] = tuple(vals)
                elif pname == "Lcl Rotation" and vals:
                    info["lcl_rot"] = tuple(vals)
                elif pname == "Lcl Translation" and vals:
                    info["lcl_trans"] = tuple(vals)
        bone_info[bone_name] = info

# Print hip and leg bones
key_bones = [k for k in bone_info if any(x in k for x in
    ["Hips","UpLeg","Leg","Foot","Toe","Spine"])]

print("=== Key bone rest poses (Euler degrees) ===")
print(f"{'Bone':<35} {'PreRotation XYZ':>32}  {'Lcl Rotation XYZ':>32}")
for b in sorted(key_bones):
    info = bone_info[b]
    pre = f"({info['pre_rot'][0]:6.1f},{info['pre_rot'][1]:6.1f},{info['pre_rot'][2]:6.1f})" if info["pre_rot"] else "        none        "
    lcl = f"({info['lcl_rot'][0]:6.1f},{info['lcl_rot'][1]:6.1f},{info['lcl_rot'][2]:6.1f})" if info["lcl_rot"] else "        none        "
    print(f"  {b:<33} {pre}  {lcl}")

print()

# ── AnimationCurveNodes — first key value per curve ─────────────────────────
print("=== First animation key for hip/leg rotation curves ===")
target_curves = {}  # (bone_name, property) → first_value

for objs in find_all(top, "Objects"):
    # AnimationCurve nodes hold the actual keyframe arrays
    for acn in find_all(objs[2], "AnimationCurve"):
        if len(acn[1]) < 1: continue
        times = None; values = None
        for child in acn[2]:
            if child[0] == "KeyTime" and child[1]:
                times = child[1][0]
            elif child[0] == "KeyValueFloat" and child[1]:
                values = child[1][0]
        if values and len(values) > 0:
            acn_id = acn[1][2] if len(acn[1]) > 2 else id(acn)
            target_curves[id(acn)] = values[0]

print("  (first-key values stored — checking connections)")
print()

# Count animation curves found
print(f"  Total AnimationCurve nodes found: {len(target_curves)}")
print()
print("Done.")
