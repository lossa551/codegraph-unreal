/**
 * Unreal Engine reflection: what UCLASS / UFUNCTION / UPROPERTY markup, the
 * Unreal Header Tool's `_Implementation` bodies, dynamic delegates, console
 * variables, `.Build.cs` modules and `.ini` config wire together — none of it
 * a call the C++ parser can see.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodeGraph } from '../src';
import {
  parseSpecifiers,
  scanDelegateBindings,
  scanReflection,
  specifierValue,
  unrealResolver,
} from '../src/resolution/frameworks/unreal';

const HEADER = `#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "HitComponent.generated.h"

DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(FOnHit, FName, Bone, FVector, Location, float, Damage);

UENUM(BlueprintType)
enum class EHitZone : uint8
{
	Head UMETA(DisplayName = "Head"),
	Torso,
};

USTRUCT(BlueprintType)
struct FHitInfo
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Hit")
	float Damage = 0.f;
};

UCLASS(ClassGroup = (Demo), meta = (BlueprintSpawnableComponent), Config = Game)
class DEMO_API UHitComponent : public UActorComponent
{
	GENERATED_BODY()

public:
	UHitComponent();

	// A comment with UPROPERTY(NotReal) in it.
	UPROPERTY(BlueprintAssignable, Category = "Hit")
	FOnHit OnHit;

	UPROPERTY(Config, EditAnywhere, Category = "Hit", meta = (ClampMin = "0"))
	int32 MaxSimulated = 8;

	UPROPERTY(ReplicatedUsing = OnRep_Health, BlueprintReadOnly, Category = "Hit")
	float Health = 100.f;

	UPROPERTY(VisibleAnywhere)
	uint8 bIsDown : 1;

	UPROPERTY(EditDefaultsOnly)
	TMap<FName, TArray<float>> Curves;

	UFUNCTION(BlueprintCallable, Category = "Hit")
	void ApplyHit(const FHitInfo& Info);

	UFUNCTION(BlueprintImplementableEvent, Category = "Hit")
	void OnHitVisuals(FName Bone);

	UFUNCTION(BlueprintNativeEvent, BlueprintCallable, Category = "Hit")
	bool CanBeHit() const;

	UFUNCTION(Server, Reliable, WithValidation)
	void ServerApplyHit(const FHitInfo& Info);

	UFUNCTION(BlueprintPure, Category = "Hit")
	float GetHealth() const { return Health; }

protected:
	UFUNCTION()
	void OnRep_Health();

	UFUNCTION()
	void HandleOwnerHit(FName Bone, FVector Location, float Damage);

	virtual void BeginPlay() override;
};
`;

const SOURCE = `#include "Combat/HitComponent.h"

static TAutoConsoleVariable<int32> CVarHitDebug(
	TEXT("demo.Hit.Debug"),
	0,
	TEXT("Draw hit debug."),
	ECVF_Default);

static void DumpHits(const TArray<FString>& Args) {}

static FAutoConsoleCommand CmdDumpHits(
	TEXT("demo.Hit.Dump"),
	TEXT("Print every hit."),
	FConsoleCommandWithArgsDelegate::CreateStatic(&DumpHits));

UHitComponent::UHitComponent()
{
}

void UHitComponent::BeginPlay()
{
	Super::BeginPlay();
	OnHit.AddDynamic(this, &UHitComponent::HandleOwnerHit);
}

void UHitComponent::ApplyHit(const FHitInfo& Info)
{
	if (CVarHitDebug.GetValueOnGameThread() > 0 || ::CVarHitDebug.GetValueOnAnyThread() > 1)
	{
		return;
	}
	if (!CanBeHit())
	{
		return;
	}
	ServerApplyHit(Info);
	OnHit.Broadcast(NAME_None, FVector::ZeroVector, Info.Damage);
	OnHitVisuals(NAME_None);
}

bool UHitComponent::CanBeHit_Implementation() const
{
	return Health > 0.f;
}

void UHitComponent::ServerApplyHit_Implementation(const FHitInfo& Info)
{
	Health -= Info.Damage;
	OnRep_Health();
}

bool UHitComponent::ServerApplyHit_Validate(const FHitInfo& Info)
{
	return Info.Damage >= 0.f;
}

void UHitComponent::OnRep_Health()
{
}

void UHitComponent::HandleOwnerHit(FName Bone, FVector Location, float Damage)
{
}
`;

const BUILD_CS = `using UnrealBuildTool;

public class Demo : ModuleRules
{
	public Demo(ReadOnlyTargetRules Target) : base(Target)
	{
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "DemoCore" });
		PrivateDependencyModuleNames.Add("Niagara");
	}
}
`;

const CORE_BUILD_CS = `using UnrealBuildTool;

public class DemoCore : ModuleRules
{
	public DemoCore(ReadOnlyTargetRules Target) : base(Target)
	{
		PublicDependencyModuleNames.AddRange(new string[] { "Core" });
	}
}
`;

const INI = `[/Script/Demo.HitComponent]
MaxSimulated=6
; a comment
+Unknown=1
+Unknown=2

[/Script/EngineSettings.GeneralProjectSettings]
ProjectID=0
`;

describe('reading Unreal reflection markup', () => {
  it('normalizes specifiers, keeping nested meta and quoted values', () => {
    expect(parseSpecifiers(' Config, EditAnywhere , Category = "Hit, Combat", meta = (ClampMin = "0", UIMax = "10") ')).toEqual([
      'Config',
      'EditAnywhere',
      'Category="Hit, Combat"',
      'meta=(ClampMin="0",UIMax="10")',
    ]);
    expect(specifierValue(['ReplicatedUsing=OnRep_Health'], 'replicatedusing')).toBe('OnRep_Health');
  });

  it('finds each reflected type and member with its owner and line', () => {
    const scan = scanReflection(HEADER);
    expect(scan.types.map((t) => [t.macro, t.keyword, t.name])).toEqual([
      ['UENUM', 'enum', 'EHitZone'],
      ['USTRUCT', 'struct', 'FHitInfo'],
      ['UCLASS', 'class', 'UHitComponent'],
    ]);
    const members = scan.members.map((m) => [m.macro, m.owner, m.name, m.type]);
    expect(members).toEqual([
      ['UPROPERTY', 'FHitInfo', 'Damage', 'float'],
      ['UPROPERTY', 'UHitComponent', 'OnHit', 'FOnHit'],
      ['UPROPERTY', 'UHitComponent', 'MaxSimulated', 'int32'],
      ['UPROPERTY', 'UHitComponent', 'Health', 'float'],
      ['UPROPERTY', 'UHitComponent', 'bIsDown', 'uint8'],
      ['UPROPERTY', 'UHitComponent', 'Curves', 'TMap<FName, TArray<float>>'],
      ['UFUNCTION', 'UHitComponent', 'ApplyHit', 'void'],
      ['UFUNCTION', 'UHitComponent', 'OnHitVisuals', 'void'],
      ['UFUNCTION', 'UHitComponent', 'CanBeHit', 'bool'],
      ['UFUNCTION', 'UHitComponent', 'ServerApplyHit', 'void'],
      ['UFUNCTION', 'UHitComponent', 'GetHealth', 'float'],
      ['UFUNCTION', 'UHitComponent', 'OnRep_Health', 'void'],
      ['UFUNCTION', 'UHitComponent', 'HandleOwnerHit', 'void'],
    ]);
    const health = scan.members.find((m) => m.name === 'Health')!;
    expect(HEADER.split('\n')[health.line - 1]).toContain('float Health');
    expect(scan.members.find((m) => m.name === 'GetHealth')!.hasInlineBody).toBe(true);
  });

  it('reads a delegate binding and the class it is made in', () => {
    expect(scanDelegateBindings(SOURCE)).toEqual([
      { ownerHint: 'UHitComponent', member: 'OnHit', handler: 'UHitComponent::HandleOwnerHit' },
    ]);
    expect(scanDelegateBindings('void A::F() { Other->OnDied.AddUniqueDynamic(this, &A::G); }')).toEqual([
      { ownerHint: null, member: 'OnDied', handler: 'A::G' },
    ]);
  });
});

describe('per-file extraction', () => {
  const extract = (file: string, src: string) => unrealResolver.extract!(file, src);

  it('mints the reflected functions that have no C++ body of their own', () => {
    const { nodes, references } = extract('Source/Demo/HitComponent.h', HEADER);
    expect(nodes.map((n) => [n.kind, n.qualifiedName])).toEqual([
      ['method', 'UHitComponent::OnHitVisuals'],
      ['method', 'UHitComponent::CanBeHit'],
      ['method', 'UHitComponent::ServerApplyHit'],
    ]);
    expect(nodes[2]!.signature).toBe('UFUNCTION(Server, Reliable, WithValidation) void ServerApplyHit(const FHitInfo& Info)');
    expect(references.map((r) => r.referenceName)).toEqual([
      'UHitComponent::CanBeHit_Implementation',
      'UHitComponent::ServerApplyHit_Implementation',
      'UHitComponent::ServerApplyHit_Validate',
    ]);
  });

  it('makes a node per console variable and command, and links the command handler', () => {
    const { nodes, references } = extract('Source/Demo/HitComponent.cpp', SOURCE);
    expect(nodes.map((n) => [n.name, n.signature, n.docstring])).toEqual([
      ['CVarHitDebug', 'console variable "demo.Hit.Debug"', 'Draw hit debug.'],
      ['CmdDumpHits', 'console command "demo.Hit.Dump"', 'Print every hit.'],
    ]);
    expect(references.map((r) => r.referenceName)).toEqual(['DumpHits']);
  });

  it('reads a module and its dependencies from .Build.cs', () => {
    const { nodes, references } = extract('Source/Demo/Demo.Build.cs', BUILD_CS);
    expect(nodes.map((n) => [n.kind, n.name])).toEqual([['module', 'Demo']]);
    expect(references.map((r) => r.referenceName)).toEqual([
      'unreal:module:Core',
      'unreal:module:CoreUObject',
      'unreal:module:Engine',
      'unreal:module:DemoCore',
      'unreal:module:Niagara',
    ]);
  });

  it('reads config keys under project /Script sections, one node per array key', () => {
    const { nodes, references } = extract('Config/DefaultGame.ini', INI);
    expect(nodes.map((n) => [n.name, n.startLine, n.endLine])).toEqual([
      ['HitComponent.MaxSimulated', 2, 2],
      ['HitComponent.Unknown', 4, 5],
    ]);
    expect(references[0]!.referenceName).toBe('unreal:config:HitComponent::MaxSimulated');
  });
});

describe('an indexed Unreal project', () => {
  let dir: string;
  let cg: CodeGraph;
  const write = (rel: string, content: string): void => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  const node = (qualifiedName: string, kind?: string) => {
    const hits = cg.getNodesByName(qualifiedName.split('::').pop()!).filter(
      (n) => n.qualifiedName === qualifiedName && (!kind || n.kind === kind)
    );
    expect(hits.length, qualifiedName).toBeGreaterThan(0);
    return hits[0]!;
  };
  const out = (id: string, kind?: string): string[] =>
    cg
      .getOutgoingEdges(id)
      .filter((e) => e.kind !== 'contains' && (!kind || e.kind === kind))
      .map((e) => cg.getNode(e.target)!.qualifiedName)
      .sort();

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-unreal-'));
    write('codegraph.json', JSON.stringify({ extensions: { '.ini': 'properties' } }));
    write('Source/Demo/Demo.Build.cs', BUILD_CS);
    write('Source/DemoCore/DemoCore.Build.cs', CORE_BUILD_CS);
    write('Source/Demo/Combat/HitComponent.h', HEADER);
    write('Source/Demo/Combat/HitComponent.cpp', SOURCE);
    write('Config/DefaultGame.ini', INI);
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
  });

  afterAll(() => {
    cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('puts the specifiers on the classes and on the .cpp definitions', () => {
    const cls = node('UHitComponent', 'class');
    expect(cls.decorators).toEqual(['UCLASS', 'ClassGroup=(Demo)', 'meta=(BlueprintSpawnableComponent)', 'Config=Game']);
    const apply = node('UHitComponent::ApplyHit', 'method');
    expect(apply.filePath).toBe('Source/Demo/Combat/HitComponent.cpp');
    expect(apply.signature).toBe('UFUNCTION(BlueprintCallable, Category="Hit") void ApplyHit(const FHitInfo& Info)');
    const impl = node('UHitComponent::ServerApplyHit_Implementation');
    expect(impl.decorators).toContain('Server');
    expect(impl.signature).toBe('UFUNCTION(Server, Reliable, WithValidation) void ServerApplyHit_Implementation(const FHitInfo& Info)');
  });

  it('finds reflected functions by their specifier', () => {
    const names = cg.searchNodes('BlueprintCallable').map((r) => r.node.qualifiedName);
    expect(names).toContain('UHitComponent::ApplyHit');
    expect(names).toContain('UHitComponent::CanBeHit');
  });

  it('routes a call to a native event or RPC through to its _Implementation', () => {
    const apply = node('UHitComponent::ApplyHit', 'method');
    expect(out(apply.id, 'calls')).toEqual(
      expect.arrayContaining(['UHitComponent::CanBeHit', 'UHitComponent::ServerApplyHit', 'UHitComponent::OnHitVisuals', 'UHitComponent::OnHit'])
    );
    const rpc = cg.getNodesByName('ServerApplyHit').find((n) => n.kind === 'method')!;
    expect(out(rpc.id, 'calls')).toEqual(['UHitComponent::ServerApplyHit_Implementation', 'UHitComponent::ServerApplyHit_Validate']);
  });

  it('indexes UPROPERTY members with their replication and delegate links', () => {
    expect(out(node('UHitComponent::Health', 'property').id)).toEqual(['UHitComponent::OnRep_Health']);
    expect(out(node('UHitComponent::OnHit', 'property').id, 'calls')).toEqual(['UHitComponent::HandleOwnerHit']);
    const members = cg
      .getOutgoingEdges(node('UHitComponent', 'class').id)
      .filter((e) => e.kind === 'contains')
      .map((e) => cg.getNode(e.target)!)
      .filter((n) => n.kind === 'property')
      .map((n) => n.name)
      .sort();
    expect(members).toEqual(['Curves', 'Health', 'MaxSimulated', 'OnHit', 'bIsDown']);
    expect(node('UHitComponent::MaxSimulated', 'property').signature).toBe(
      'UPROPERTY(Config, EditAnywhere, Category="Hit", meta=(ClampMin="0")) int32 MaxSimulated'
    );
  });

  it('links console variable reads, modules and config', () => {
    const apply = node('UHitComponent::ApplyHit', 'method');
    expect(out(apply.id, 'references')).toContain('Source/Demo/Combat/HitComponent.cpp::CVarHitDebug');
    const demo = cg.getNodesByName('Demo').find((n) => n.kind === 'module')!;
    expect(out(demo.id, 'imports')).toEqual(['unreal-module:DemoCore']);
    const key = cg.getNodesByName('HitComponent.MaxSimulated')[0]!;
    expect(out(key.id)).toEqual(['UHitComponent::MaxSimulated']);
  });

  it('picks up a new delegate binding on sync', async () => {
    write(
      'Source/Demo/Combat/HitLogger.cpp',
      `#include "Combat/HitComponent.h"
void UHitComponent::OnRegister()
{
	OnHit.AddDynamic(this, &UHitComponent::OnRep_Health);
}
`
    );
    await cg.sync();
    expect(out(node('UHitComponent::OnHit', 'property').id, 'calls')).toEqual([
      'UHitComponent::HandleOwnerHit',
      'UHitComponent::OnRep_Health',
    ]);
  });
});
