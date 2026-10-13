//! Bounded file integrity checks shared by registration recovery and project packages.
use std::{
    fs::File,
    io::{Read, Write},
    path::Path,
};

const fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut index = 0;
    while index < 256 {
        let mut value = index as u32;
        let mut bit = 0;
        while bit < 8 {
            value = if value & 1 == 1 {
                (value >> 1) ^ 0xedb88320
            } else {
                value >> 1
            };
            bit += 1;
        }
        table[index] = value;
        index += 1;
    }
    table
}
const CRC_TABLE: [u32; 256] = crc_table();

pub(crate) fn crc_update(mut crc: u32, bytes: &[u8]) -> u32 {
    for byte in bytes {
        crc = CRC_TABLE[((crc ^ *byte as u32) & 255) as usize] ^ (crc >> 8);
    }
    crc
}

pub(crate) fn copy_checked(
    reader: &mut impl Read,
    writer: &mut impl Write,
    expected: u64,
) -> Result<u32, String> {
    let mut remaining = expected;
    let mut crc = u32::MAX;
    let mut buffer = [0u8; 64 * 1024];
    while remaining > 0 {
        let count = reader
            .read(&mut buffer[..remaining.min(64 * 1024) as usize])
            .map_err(|e| e.to_string())?;
        if count == 0 {
            return Err("媒体文件不完整，原项目保持不变".into());
        }
        writer
            .write_all(&buffer[..count])
            .map_err(|_| "磁盘空间不足或写入失败，原项目保留")?;
        crc = crc_update(crc, &buffer[..count]);
        remaining -= count as u64;
    }
    Ok(!crc)
}

pub(crate) fn checksum_file(path: &Path, expected: u64) -> Result<u32, String> {
    let info = std::fs::symlink_metadata(path).map_err(|_| "待恢复媒体文件缺失，登记记录保留")?;
    if !info.is_file()
        || info.file_type().is_symlink()
        || info.len() != expected
        || expected == 0
        || expected > crate::media::MAX_MEDIA_BYTES
    {
        return Err("待恢复媒体文件类型或长度已变化，拒绝登记".into());
    }
    copy_checked(
        &mut File::open(path).map_err(|e| e.to_string())?,
        &mut std::io::sink(),
        expected,
    )
}

pub(crate) fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|_| "媒体目录同步失败，恢复记录保留".to_string())?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
