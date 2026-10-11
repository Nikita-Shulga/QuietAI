"""Package the shared desktop app with Electron and a self-contained monitor.
Requires Python 3 and .NET 10 SDK. No npm dependencies. See README.md.
"""
import argparse, hashlib, json, os, plistlib, shutil, stat, subprocess, urllib.request, zipfile
from pathlib import Path

VERSION='4.2.4'
ELECTRON='44.7.0'
TARGETS={'win-x64':('win32','x64','win-x64'),'win-arm64':('win32','arm64','win-arm64'),'mac-arm64':('darwin','arm64','osx-arm64'),'mac-x64':('darwin','x64','osx-x64')}

def run(*args, **kwargs):
    subprocess.run([str(a) for a in args], check=True, **kwargs)

def download(url, file):
    if not file.exists():
        file.parent.mkdir(parents=True,exist_ok=True)
        with urllib.request.urlopen(url) as source, file.open('wb') as output:
            shutil.copyfileobj(source,output)

def extract(archive, target, mac):
    links=[]
    with zipfile.ZipFile(archive) as source:
        for item in source.infolist():
            relative=item.filename.replace('Electron.app/','Quiet AI.app/',1) if mac else item.filename
            if mac:
                relative=relative.replace('Electron Helper','Quiet AI Helper')
                if relative=='Quiet AI.app/Contents/MacOS/Electron': relative='Quiet AI.app/Contents/MacOS/Quiet AI'
            path=target/relative
            if not path.resolve().is_relative_to(target.resolve()): raise RuntimeError('Unsafe archive path')
            mode=item.external_attr>>16
            if stat.S_ISLNK(mode):
                links.append((path,source.read(item).decode('utf-8')))
            elif item.is_dir(): path.mkdir(parents=True,exist_ok=True)
            else:
                path.parent.mkdir(parents=True,exist_ok=True)
                path.write_bytes(source.read(item))
                if os.name!='nt': path.chmod(mode&0o777 or 0o644)
    # Deeper Current symlinks resolve before framework root aliases.
    for path,link in sorted(links,key=lambda item:len(item[0].parts),reverse=True):
        path.parent.mkdir(parents=True,exist_ok=True)
        target_path=path.parent/link
        if not target_path.resolve().is_relative_to(target.resolve()): raise RuntimeError('Unsafe framework symlink')
        os.symlink(link.replace('/',os.sep),path,target_is_directory=target_path.is_dir())

def rebrand_mac(bundle, app_source):
    for file in bundle.rglob('Info.plist'):
        if file.parent.name!='Contents': continue
        info=plistlib.loads(file.read_bytes())
        main=file==bundle/'Contents/Info.plist'
        helper=file.parent.parent.stem
        suffix='' if main else '.helper'+('.'+helper.replace('Quiet AI Helper','').strip(' ()').lower() if helper!='Quiet AI Helper' else '')
        info.update(CFBundleDisplayName='Quiet AI' if main else helper,CFBundleName='Quiet AI' if main else helper,CFBundleIdentifier='org.quietai.desktop'+suffix,CFBundleShortVersionString=VERSION,CFBundleVersion=VERSION)
        info['CFBundleExecutable']='Quiet AI' if main else helper
        if main:
            info.update(CFBundleIconFile='QuietAI.icns',LSMinimumSystemVersion='14.0',NSAppleEventsUsageDescription='Quiet AI requests the selected shutdown or restart action when your power plan finishes.')
            info.pop('CFBundleURLTypes',None)
        file.write_bytes(plistlib.dumps(info))
    shutil.copyfile(app_source/'icon.icns',bundle/'Contents/Resources/QuietAI.icns')

def archive(folder, output, mac):
    with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as target:
        for root, dirs, files in os.walk(folder,followlinks=False):
            # os.walk lists directory symlinks in dirs; package them as symlinks.
            for name in files+[name for name in dirs if (Path(root)/name).is_symlink()]:
                file=Path(root)/name
                relative=file.relative_to(folder).as_posix()
                if file.is_symlink():
                    item=zipfile.ZipInfo(relative);item.create_system=3;item.external_attr=(stat.S_IFLNK|0o777)<<16
                    target.writestr(item,os.readlink(file).replace('\\','/'))
                else:
                    item=zipfile.ZipInfo.from_file(file,relative);item.create_system=3
                    item.compress_type=zipfile.ZIP_DEFLATED
                    if mac:
                        mode=0o755 if '/MacOS/' in relative or '/Helpers/' in relative or file.name=='QuietAI.Agent' or file.suffix in ('.dylib','.so') or file.read_bytes()[:4] in (b'\xcf\xfa\xed\xfe',b'\xce\xfa\xed\xfe',b'\xca\xfe\xba\xbe') else 0o644
                        item.external_attr=(stat.S_IFREG|mode)<<16
                    with file.open('rb') as stream, target.open(item,'w',force_zip64=True) as destination: shutil.copyfileobj(stream,destination)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('target',choices=TARGETS)
    parser.add_argument('--cache',type=Path,default=Path('.artifacts/cache'))
    parser.add_argument('--output',type=Path,default=Path('.artifacts/releases'))
    parser.add_argument('--rcodesign',type=Path)
    parser.add_argument('--rcedit',type=Path)
    parser.add_argument('--repo',help='owner/name of the GitHub repository the app checks for updates')
    parser.add_argument('--skip-agent',action='store_true')
    parser.add_argument('--folder-only',action='store_true')
    args=parser.parse_args()
    repo=Path(__file__).resolve().parent.parent
    cache=args.cache.resolve(); output=args.output.resolve();output.mkdir(parents=True,exist_ok=True)
    platform,arch,rid=TARGETS[args.target];mac=platform=='darwin'
    file=f'electron-v{ELECTRON}-{platform}-{arch}.zip'
    base=f'https://github.com/electron/electron/releases/download/v{ELECTRON}/'
    download(base+file,cache/file);download(base+'SHASUMS256.txt',cache/'SHASUMS256.txt')
    expected=next(line.split()[0] for line in (cache/'SHASUMS256.txt').read_text().splitlines() if line.endswith(file))
    if hashlib.sha256((cache/file).read_bytes()).hexdigest()!=expected: raise RuntimeError('Electron checksum mismatch')
    agent=cache/'agent'/rid
    if not args.skip_agent:
        project=repo/'src/QuietAI.Agent/QuietAI.Agent.csproj'
        env=os.environ.copy();env.setdefault('CODEXQUIET_BUILD_ROOT',str(cache/'build'))
        run('dotnet','build',project,'-c','Release','-r',rid,'--self-contained','true','--no-incremental','-p:DebugType=None','-p:DebugSymbols=false',env=env)
        run('dotnet','publish',project,'-c','Release','-r',rid,'--self-contained','true','-o',agent,'-p:DebugType=None','-p:DebugSymbols=false',env=env)
    folder=output/f'QuietAI-{VERSION}-{args.target}'
    if folder.exists(): raise RuntimeError('Use a new output directory; this package already exists: '+str(folder))
    folder.mkdir();extract(cache/file,folder,mac)
    bundle=folder/'Quiet AI.app'
    app_dir=bundle/'Contents/Resources/app' if mac else folder/'resources/app'
    shutil.copytree(repo/'desktop',app_dir)
    # The in-app updater checks this repository's GitHub Releases (GitHub Actions sets GITHUB_REPOSITORY).
    update_repo=args.repo or os.environ.get('GITHUB_REPOSITORY','')
    if update_repo:
        manifest=json.loads((app_dir/'package.json').read_text(encoding='utf-8-sig'));manifest['updateRepo']=update_repo
        (app_dir/'package.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    shutil.copytree(agent,app_dir/'agent')
    shutil.copyfile(repo/'hooks/ClaudeHook.ps1',app_dir/'agent/ClaudeHook.ps1')
    shutil.copyfile(repo/'LICENSE',folder/'LICENSE-QuietAI.txt')
    # Users get a short quick start; the full docs live on GitHub (linked from it).
    shutil.copyfile(repo/'START-HERE.txt',folder/'START-HERE.txt')
    notices=folder/'licenses';notices.mkdir()
    packages=Path(os.environ.get('NUGET_PACKAGES',Path.home()/'.nuget/packages'))
    deps=json.loads((agent/'QuietAI.Agent.deps.json').read_text())
    for name in deps['libraries']:
        if not name.startswith('runtimepack.'): continue
        package,version=name[len('runtimepack.'):].split('/')
        root=packages/package.lower()/version
        files=[p for p in root.iterdir() if p.is_file() and (p.name.startswith('LICENSE') or p.name.startswith('THIRD-PARTY-NOTICES'))]
        if not files: raise RuntimeError('Missing runtime redistribution notices')
        for source in files: shutil.copyfile(source,notices/(package+'-'+source.name))
    if mac:
        rebrand_mac(bundle,repo/'desktop')
        if args.rcodesign:
            run(args.rcodesign,'sign','--timestamp-url','none','--entitlements-xml-file','scripts/entitlements.plist',bundle,cwd=repo)
        elif os.name!='nt' and os.uname().sysname=='Darwin':
            for binary in (app_dir/'agent').iterdir():
                if binary.name=='QuietAI.Agent' or binary.suffix=='.dylib': run('/usr/bin/codesign','--force','--sign','-',binary)
            run('/usr/bin/codesign','--force','--deep','--sign','-','--entitlements',repo/'scripts/entitlements.plist',bundle)
        else: raise RuntimeError('Cross-built Mac packages need --rcodesign. On a Mac, built-in codesign is used.')
    else:
        (folder/'electron.exe').rename(folder/'QuietAI.exe')
        if args.rcedit is None and os.name=='nt':
            args.rcedit=cache/'rcedit-x64.exe'
            download('https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe',args.rcedit)
        if args.rcedit:run(args.rcedit,folder/'QuietAI.exe','--set-icon',repo/'desktop/icon.ico','--set-version-string','ProductName','Quiet AI','--set-version-string','FileDescription','Quiet AI','--set-version-string','CompanyName','Nikita Shulga','--set-version-string','LegalCopyright','Copyright (c) 2026 Nikita Shulga','--set-file-version',VERSION,'--set-product-version',VERSION)
    if not args.folder_only:
        archive(folder,output/(folder.name+'.zip'),mac)
    print('Package ready:',folder)

if __name__=='__main__':main()
