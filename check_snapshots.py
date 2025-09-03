#!/usr/bin/env python3
import sys
from PIL import Image
import numpy as np
import glob

def check_image(filepath):
    try:
        img = Image.open(filepath)
        img_array = np.array(img)
        
        # Check if the image has any non-black pixels
        # Black is typically (0, 0, 0) or (0, 0, 0, 255) in RGBA
        if len(img_array.shape) == 3:
            if img_array.shape[2] == 4:  # RGBA
                non_black = np.any(img_array[:, :, :3] != 0)
            else:  # RGB
                non_black = np.any(img_array != 0)
        else:  # Grayscale
            non_black = np.any(img_array != 0)
        
        return non_black
    except Exception as e:
        print(f"Error processing {filepath}: {e}")
        return False

# Check multiple snapshot files
patterns = [
    "tmp/boot/sm64_fixed_f*.png",
    "tmp/boot/sm64_natural_f*.png"
]

for pattern in patterns:
    files = glob.glob(pattern)
    if files:
        print(f"\nChecking {pattern}:")
        files_with_content = []
        for i, filepath in enumerate(sorted(files)[:20]):  # Check first 20
            if check_image(filepath):
                files_with_content.append(filepath)
        
        if files_with_content:
            print(f"  Found {len(files_with_content)} images with non-black pixels:")
            for f in files_with_content[:5]:
                print(f"    - {f}")
        else:
            print(f"  All checked images are black (no visual output)")
