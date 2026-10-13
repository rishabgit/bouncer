#!/usr/bin/env node
// Pure Node tests: in-memory platform only. No native commands or filesystem changes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  EXTENSION_ORIGIN, LABEL, installSetup, launchSetup, main, mergeOrigins,
  parseArguments, parseOrigins, prepareSetup, setupPaths, uninstallSetup, launchAgentPlist,
  upgradeSetup, QUALIFIED_OLLAMA_VERSION, PINNED_MODEL, PINNED_WEIGHT, PREDECESSOR_SCRIPT_HASH,
  CORRECTED_PREDECESSOR_SCRIPT_HASH, HELP_TEXT,
  STARTUP_DEADLINE_MS, REQUEST_TIMEOUT_MS, StartupConnectionError, nativeMetadataRequest,
} from './macos-ollama-setup.mjs';

const sourceText = readFileSync(new URL('./macos-ollama-setup.mjs', import.meta.url), 'utf8');
const hash = text => createHash('sha256').update(text).digest('hex');
// Exact public predecessor bytes qualify the upgrade; this is not an ownership
// marker fixture or an adapter bypass for arbitrary hashes.
const predecessorSource = gunzipSync(Buffer.from('H4sIAAAAAAAC/8Vce3PbSHL/359ipLgW5JoEtZvL5kJKdmlt3Z1yWslZyXtJ0cwZBIYkLBDA4SFa0em7px8zg8GLkrf2kq1aSwDm0dPTj193z+ifDiZlnk2WYTyR8Z2Ik0C+mEzEVSozr0iycRJH92Lr+VfXIs1k6sHbMIldcbMJc7EKIyngZyzvZCbCbZpkhQzE8l4UGynkl0LGObamEaPI23riyP3dkfvPIpNekIuri4vTn07/evXz+R/PL6/FKku2IixyAZSEWRJvZVyMgKRC5DKDGdzPuRpsUxRpPp1M1mGxKZeun2wnCY2vfyyjZDm548lwYX4Sr8L1hH+46wQHuQEavTR1crHMkh1MMfZ8X+a58DfSv10mXwQwYYv0ON86MxEkREqZw5ILsUoyWCSsPZdFmbovePHiQfiwtEL+ycs3I5F5cZBsP3w4fyceeXUOMnjqZ/dpkTgz3etb4QEzc7vJKq8+PwArpf8HYPb1few3htqEUfDXNEuQcrvLJtnKIMzqrROrSeoVG/sbPtsD4OZ++PniJnmPDWvDlFkELV/IL9QUmJoX4uw/b84ur8+vLtV2ihPh+BvoI8dGEGDHlrfh5+3GWyWJv4oSCb/G/nLtBbfx7Tq49bcwbm3Yi9Mfzy5wrCjxvchdJmXsgyTwNo+TLFyHMS6KW1/95fLsZ2yt2o1BcpN8XG89vvvOdAjCtYQfJ6IAIsXJa2v7Bk6+8b7/lx+coVumAbwcYJuhy10GzkZ+cYZ6HJRMGOXOi0qJw3x6+fDv11eXbl5kYbwOV/cD+gTSXEbRSHw/fPwYf6pYuAJqUa9gU7JcXjGd3GUoHl4IEa7EQA1+ckKDiL//XVRvyjiQqzAG5au9dpwhqFpRZrGYL2ZqnOI+lclKtTrAVkylg30n84/Zx/jj0WLiFrhMpmEIsg46Aoq+E2dZlmQD5zyGT2EgmKkiCvNiBgpi6y5PkYudzCRYjzAG4+Aiz4TaXGiThdDgRMxd18XBr6Wa0s3TKAQuj4D9Wy8dYNN75Cz94kK/7WA4dEFIC5kNfkySSHrxcEiLRN0cVDPcC1itmoq5yXzgkcLYj8pA5gNQ8q51/gX0y/cyvdBcbEsYdymBr3kS3VXmLlEmE74BAWj+PL9QMqesBK9diEiCHckifkACH/AR2IDzgs4xacMZaJ3vFf4Gvj/Ff+rx3A0Qj4YJB3MHjenUGQmHrSr+1lJcfLlN/qfxJvdWXhaOd3Jpf1hUPIVVuWCbisRPoiHNKVDIDvD9JsmL2NtKfIHPYFgz+zn18nyXZIF+zqWXASvU0wY01Bpw7iA9k9bcYLpwzKES7dw5/PhRizYzWUuEaLP4Cn0faFVYAPfKZRT6Rgg8YGhepuzwvkLuBbEe/1dqqeRy9uKxbQy2MlsbYwAKwsMywVqrLb2ZmybuKvKKn0BrbHMyHLVs9GK4cD8nYUxq1kkCyS06gHyADoXn1qYzkz7IO2gl+RIeCVvBTlyEy8zL7nFTTlPQZJ9gg7hmluHrH9lC468MDRSZzCe1PN4aM9OIHnM/C9Niak1aNQAptS0+q932M4yq+hZgyPu6JrtYZvkmTAlo6C7geG77erha6cfYSvdI0RhO9zLlwoPVb07XsP05PIO7IEf36FLfTzTQY+eOfNlGZ7nvpdJ2D4pd12TH1QcX4Frk+XIwmX9z/PrQWUzWI4A2gOB8MJloSgcPwvnGmcI/3jadIVnH9BQV9PCaHtb8cEgPfysTejx0DqlbmuQzRzwO52bcRbccRdV63+MKB4gjUK5Gajvx98rVHRDvwvx0CTa2BNerm5Mit77aQ7CiH6EX04quO4tX9mQdtl4PCEQBHyM5jsClEvgqC28JWBcnZuXP5N9KEASt12oDPh2/gf0RgFXRFJ4cfuceHYKK+0kA450cfrj5w/j3h29ef4yPD95dvb35r/dnLCzi/YcfL87fisPxZIL6IieTdzfvxPuL8+sbAYNMJmeXh+KQLPVkstvtXA9bEfCFhvnkfYaSWNxfwGBj6OAGRXCI8/DwNYJeHwehX8BHIY5v5f3rC28po+MJ/nrMSOC1FsfjiXphGsNE68zbnmbrEk1drvp5WebdUytoZwapZNXsX33I7sbWJvU1H4+zMgalA4sx3iTJbZ3QSUUOEf1zGZ8WF4kXKGqLrJST6vOfpUxPo/BOqs8rL8rt7+8ZXd8Abqqz6UfPv11nYMgCa/7jCbH3eEKsf004DzTCqIKSnJ88f+AFXgo6U8m9egFWwCsARGwZngVetgvBHnWBADBoYOpoYAg2lJ6RhFLQRvHbjIKW8ZgDOCmKBIi4C2EYCQvdbcBNucr+N6l8iwFTtqUJ8kGS0k9LT9Ub1+d2bMOv0eo+Ra2aIAe6VGeFldhoC2+FVorpBMZW5CuN65yerP51kaSpDDoI+I8SIjcViMbAXiDmXk0Evwo/ClGkiXthEIEZAFwXk5+HdhadyrnwPC4FkhsZgQKqSBhWBsMkSD6sOIPfw8Imew5eKi69CA1rJcM2eNEL24LedFmqt9CB9hQbCB4NJ1QvqkGtae0xOTqw5hbffCOa7LzAz+eF3L4LczR/gcZKLXJUAxX2g9jjjilG0ygChxHwk5DyahX6IRD84RzgVZYXfYxm+gB+bceBIsEV5xDqpBL+AaBFDQTxGERml5RRAEG3Lzk0t9b/2BBuL7hGJKAVbsSW3YY3mbcDYKMVEnsMqI1LEMIwlZqpkKxjny4TgagigKVbsk8syhVpGAzQmPjAwQA9wuwUQhKGw3n2xwNXGryo3rD+MkaykW0zTN5QEkXnLky0whpmogJcEw3gEhoiA8RRNcPspwSX+5LYvlDgXMWb/KXGh2bweTD577k3Xh2N/23x8MPvHl8q/8092StgZC7evMHIVo/Pn8Eh8ngTC3DmExZC/Oro9haNnWowOOAGUVP8nySRLL5F4bCbB14QyIBNJZO85PDVabXUu6Za5zWOdY4deXlBDABym+xVVKJRggD1FxP/UzoBFl4bqNVKj9Rljj7EtzHIi0jqQkiBEUDDeA12fusF2nbXshzdK+1rZ62vr4lNeWVznxirkuBmkLQ3+fG89bJFYQHuMSr0zVCrm1q5HpV2Ug1pR5p6Mey2ChoVgDYzbUEfnWiKGDDyvLOaQehUGO0SdLeOtdEnFf3iaKppe23c0Fqa0afelVlx1FOLs4JuZWExQbvTAchILeGxjoN2YbG5gNiu4SkgkgIrtgT8Z/sMDAKBBxDNkcl8/Bi/fKhywAOV9BOGSbsMfJviEvYdCf4XE74gjTlA0qlAsAohVuUd1CI0AQPyC6swJjTzYO3ANrlrj0523l4hwK2zKndRrdMKLycT8d7LcxEBuRn4bZXf8BAqre9mOv8fw9c0idD76DwJvEtEDuAI0BWIj2stHgD8wKHCA4unX6BbaSQ534i5U8ZAoozvKFVQqxg4CzGFBr2f1XCLJrZNmHOdy4bIFcJ7GYzQZd6FSZm34flaFtqSsLjqTl1yqvNzVXpICaoISjSonGOZoWPeAUeNIexz00BL35YZijtjcIWfCZ1XfRTmA7F9eLRlmUPdEzsDpJdPmaDKrrFdEDV4if5PQYWvQL2/FdrtSVCpjK1Zh78LMIfTzhiNmdv2YKmKmE6UvSPLP2VoNFK7g/lC1tcRMWXEOWCWgGkr+6aSRaovy9O0nvTTPNXqBGwloMldFZaSAW3PVFsmDcDBtU33wKERFfvOTHJjajTT5GY0gRSr5aD8MMlcZUsdFRoSoodV4pa8pbQxVetCX453SXYLdmErCxi58MT7q+sbxKWZ/EzaQhKOkRIv13VGeuz3Gq3WAoooSVLUWwFGAxMqFPH6UVIGJjxAccW2MxUBcFQWJGCtsHgng7BeTKym7IwNqfrJASKauHsVIooN1uvCOATLFghcJjkdWI4Pzxj9WcEfrhiIwHAe00V6Qtd1B90QFG2eHVCFVsDTjqlKTFW1wipVg1ASwi1MRARCjykP6pTLiPfCcPkSibJyXt6dF0b8W0G75aksGSsV2+CFEskF/1jKjQeWCBREB/0CpQhrvsRSnJmXnMscM1PNUrCqlmljmOs0vKFSacQINzzH8cIM4h3tsZXcgFhWVWjVRcWaYFjjvC5ehn+gHa5iMTJMgKdCun3iAIecKHnQEYI44JcW+BFVwWTMpjj5cj+CDVjBumP8BhIBzpH2Iswr3dUSAcTzK+DZz+S6mVXoGtldcCCJZdmc5i8BWFTsrAC4qQlBnBFytf6qQPRnlYqw6sZpzMLDsiEnMQwH7Jhdl/dRd2hs4ZVFgikhn3REwW21kEcb32xvwQZXCfNhN/Zpp9WVTdRpeKquDtTLYT88es7QveUB0ztPSlDjG5Cb/pnQn/XA4WcQ0c72t/PjLVssaoFCP2kG4nrk9afETfT7Aei9RQQ7KDCKkgSOnBtYq3AF/VhLyabFsM8ginxwouTTH6P6AY1KWEjIPaveg4BGia/r9BQ0lNh3wxJd3milTGfV6+4c5eyrkAwg3EuSci+AAXAZoIAZ7SHoWmUjUPtG6AtilIGQjoMAt8oMdnApI7defabzMRBRz63MUX0j9RMJgn5AmL6wK9W1oAoHHZq4vauKwSvlAx6gvl6E/cCZ+X6Zhrpcaa+I9kkvGAyYFTERctPzw9aeUepq0A8ruvDbTaeZ7RuCIQKXV5BW8FwNm4n7E4CpixII7+pHCjQEtkJRG61bZw80PSf1HIKFoXVTT+VTTkynPdkCcN+Ghgaa6xhah837c7Nvvto+wNQ6gFfJB5VS7EKvdk5uKuyAlc3EtEbeCPmxF1jSFE+CS1ElLqY6A9C2wXZJlZs20geMiMW0nkTQpdtGBm+6n9EWIodtwgNXAHgfTMHZAeQDGwB2VJWRqxeq5KtfiEczVC2rNa0kyNTd0fOYfOBUHDxDxtTqqvTVVMvoSNjZr6lZS49rZpmpO+gqRVPZmHYv7IQnK2o5HtsB9SZOIGQ+ea3kkGWTz1yhfvEhJU5EWT4GfAN8pLKcdWZGAWnL3s7ZPMMDGLFiQaZ3Xje3bQlbjAiLt8RqTsB2XrfP+GMBYLdh0gmgcGFgsahOlDQhSY28fhfO/ymuuGmZbwaNlZlmj+rn3uxElcj4FdkJ69TnDPc2u2+V5jAo8Mssw96cuHMMgX2pCs/K4eJ/rd1GfuiP9ZSRPq+KEB5Ub+6MPTr802ePKm61sZFxKY42dVWuc1Q7aWJ5bHW8o8cO1QRG4asz7WzQvSHdVMjCumAMwFzhatoJfboMnHG4Cvl0GQAQFWCbYEbH1hhSM3aPqnhlF2K8VcYmZsH4IMYDjtRoVo8WLayfya1Hp5viKvEUSD+kQ7wOGxBhilADiTJUSTtgqFNQ0pAcdIoIiYNuOkXLUV6RiFskDldkwUSYJt8gRKVY2q3GO18JDwz7ioKoQkffWkIperORKEczAM/CAGOuCcVKrqUidSkb7s8EGpNa89tPmxytuBkCylwOhsNmTrbWx4zKyklMtY6K7TtP82Qqrwc4Px8Xf70xt3PrICon/cXWqiKgnTKJ559AhCuhapQfDprQCEtyPeW6TiBawUgWPZMawui5Vk6uTuzRMYnnHDjoPUn4Dzp4cJn0JJmss4a9EN6UTZ+P2NUKFEYnpcZUW4xk0FkzciD17IYi5dnoXOyB421AXsPX3ZXElv6q+j7jpDNzBLk2rXZP+oCxss4g6wftGi7IYFJVc1tozZ6VrPCJERQAHkpbOsGccVtdkI5cT7vo+6ajfmswxbSxbDeS8RqixDfN9wadqkCCSVEOAAzzL1j+xIhCJRrRFNNRDnBghUoSMH7lPK0oY10jqeTK+dZh49xVD7ORVUyBAOElHmPK1mX49WjxHweU2CSTNqCCUEjNnv7/AQ0Z5V4M9zvt39Ar7tlFqrPa21dtq4V5Ox1gF2pjvjr74FUzDazyx0pPKVPsil8QZN3bFYxOgDUDEPLHsxtl2EqyhsATjYh6XLRJ6P5aL93lcDgz3HfA7oOesut0HWMPlfMEvFc7q6bgsvN/Cg9apffnoYVe9W2f6vgqPU7KIgfgaFeOrHNTXImxkEN/ebZfz3sOqLRN1N4TF50VfjtCbalkraVmunXmpL+t2ayGHem/NMEM5jUyp/xkm4KNRqOxLAurjiFoLlA7NJZ0fCArU7pQYdjOIYlOVOZ7ud5nLowm2jbjz616ST7RBwl5KmYEwyxt0Q30Oo1NXhXscKyND0cgOYXESRTU5KyMixBCH4EHJDIFA5XX6C+/4KR2/WWmPTUmn7kSDhARRCaQOZ1HhxjM8BsCQFD4DaDbz8kSWt8rdsKPNVaqMOJiqkC+QPx5f7C4CU7MnIqm8MzfyKDEyC6TsN4nTB8XDU5ZoAb2qQJOu9Bh/JP6DcMBXzx0sVrslllEe2pGpCuZ7z2MAnOVAbetSkpfdJ1fp6aonXXuiBuhpeARaoPyVwtRoOjbN7TwGYkG0IS/4lVM06ntXtmx4oPrGy0+u7w6u7wxd/JmXRacy74J2hp0liqXb1J0zetbSIob5u/098FQH4mEt9f322UCUfZFGN8OumD+tSoUEGP0HAiHKQ2BYdFSivx+G8EAuVUVqJ2kre9Ha6O+jqPc5dfxk1Pez2cqztXDT8z9/hpWsuWorgiuy8jL+O1I6XGDncZgARuQm/qar0oSOGWx+n0H45ul1WeoQz3N29IJayyd5rU0AhsDhXxymeir2ldosqo1NPe1OflvKL7VOR/Ndw/lMqorTS0FaPsLIJPWWycT4SonBI+Sfz06Uii1tgVP5XR1EFKdKSOEo1Gf4kDVHI8em5atS72N2p85cdZ7NLKS8drJyKqu2c4X8PaB2wFL7NG5qU8vH3CER7fYpuPGYcZPM80/Gs8IrulfY8sq8tbgdndfTKb1KPnBMLaNgAxfhiRIIALNwZWpwLRjkWxDnxNvlGbcgAD6XowGTGUmIAZN6BAEKb0OszCvUyXr6Tx/D5t/Qy4rpoFygVZ2L6qW3bcPd7bV0PQdEqPKuM0qZeHqhhuCx+qQzwgPcprL0Wyd7b850Go6IvMdhAmevwzXAGYk5uDTMK1+LnBv1Rr6ri180n9oAkHLFk+1cAJ5Kl4+kPFaejnxyaJg+EiQTHcA3JKWVLJ/6gruJ4sRtQumGM9M9V9MwKqnvwsw0ULXvvCYIL7Td7KqD/pNVfBEIFN9R5JVqdNUm6YtO19BImPtR6TtI7bDIzY0I9yykXIYVha5klBbe34jMQ4k+G06O9ohxXVpswRXFT+rVCMmGXHz7ePLKw4uqC9+r3sB+6qL7kAJHXivhq+FfyYcsaeoSXD7qPHcWfeeKyZDru5tTtW2jJ4l8dW124/xy8kIr4HMTJmuH9QgL1RO77vn4xnc5o7DdNUfHSh0grZ5IF7blv6LxpQPNfc8B5WBYC9hpzGqpIFSylz9LQO6lu6Yq3vIqPFYBWP8wBvCv5s4jR/rNzxVGU8drAFnkps8qtN9hRBvLLfvJfLY3Rl1u4ed2VcHA5y9N9Oszq2Lc/VJ7UyM1cvK7VRH6ajUhOAZT4F+gSUfzdSvx2SIVQZXvXz1qg4EPbV9mG+HxnNqtKgQnd4u/HMKA914WDclVQaK2vYfz6ZEGx2alcqecARumYzGWEwWTdoqtVSkI9Lnk95U7ml+0H8Dpk71QbVe8Up8t1A97Vcu3838SwjBJ4zTeXJJn6ViwtXthKr20V7aXJPn5oBc5eD74UIz/9Urm/3WUkmaTcfF0IzV+LCoJYKpe+9NLJtsMgBUTMICQf8fp0CT0NyhN2+IyVqBm3dJE+teWgVXAck2xzk4qY3TwWqzk3RmTeV2+O9PhTF4+Fk9/VYdDbbSt3UzqOxf/Yq+Iqz7D254YUyGDkMn5cTxhovZS3N+BO1bPcnRbRu7jGiTh0YZmixSFO+9t/HUaNqimtH2H7d8YjRlrc1g+8rQT43VMO/7x3wQpjbcddr1iVw7Z6ko3rV2dQ5WASS1djWk8X1IxO7PU/HGM/DA7U8iqkUPGn//iWRrWP0BKOWCm4hAj0AvFDbYAkXeGmOdClmGxVu+dvMd3+f6X+v6Sa3ITQAA', 'base64')).toString('utf8');

// Exact reviewed startup-correction predecessor, before public CLI help changes.
const correctedPredecessorSource = gunzipSync(Buffer.from('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', 'base64')).toString('utf8');

function pinnedMetadata() {
  return {
    details: { format: 'gguf', family: 'gemma4', families: ['gemma4'], quantization_level: 'Q4_0', runner: 'llamacpp', parameter_size: '4.6B', parent_model: `sha256-${PINNED_WEIGHT}` },
    capabilities: ['completion', 'thinking', 'tools'],
    model_info: { 'general.architecture': 'gemma4', 'general.parameter_count': 4628569635, 'gemma4.block_count': 35, 'gemma4.embedding_length': 1536, 'gemma4.context_length': 131072 },
    modelfile: `FROM /synthetic/blobs/sha256-${PINNED_WEIGHT}\nRENDERER gemma4-small\nPARSER gemma4`,
    template: '{{ .Prompt }}', parameters: 'temperature 1\ntop_k 64\ntop_p 0.95',
  };
}

function memoryAdapter(initialOrigins = null) {
  const files = new Map();
  const calls = [];
  const adapter = {
    home: '/synthetic/Home & <Owner>', cwd: '/synthetic/review', platform: 'darwin',
    nodePath: '/synthetic/Node & <runtime>/node', sourceText,
    files, calls, origins: initialOrigins, failOpen: false, appPresent: true,
    clock: 0, serverStarted: false, serverOrigins: null, transientFailures: 0,
    version: QUALIFIED_OLLAMA_VERSION, metadata: pinnedMetadata(), acceptEveryOrigin: false,
    read(file) { return files.get(file) ?? null; },
    mkdir(directory) { calls.push(['mkdir', directory]); },
    write(file, content, { exclusive = false, expected } = {}) {
      if (exclusive ? files.has(file) : files.get(file) !== expected) throw new Error('file conflict');
      files.set(file, content); calls.push(['write', file]);
    },
    remove(file, expected) {
      if (files.get(file) !== expected) throw new Error('file conflict');
      files.delete(file); calls.push(['remove', file]);
    },
    appExists(app) { assert.equal(app, '/Applications/Ollama.app'); return adapter.appPresent; },
    getOrigins() { return adapter.origins; },
    now() { return adapter.clock; },
    async sleep(milliseconds) { adapter.clock += milliseconds; calls.push(['sleep', milliseconds]); },
    async request(apiPath, options) {
      calls.push(['metadata', apiPath, options]);
      assert.ok(options.timeoutMs > 0 && options.timeoutMs <= REQUEST_TIMEOUT_MS);
      if (!adapter.serverStarted || adapter.transientFailures-- > 0) throw new StartupConnectionError();
      if (apiPath === '/api/version') return { status: 200, body: { version: adapter.version } };
      assert.equal(apiPath, '/api/show');
      assert.deepEqual(options.body, { model: PINNED_MODEL });
      const accepted = adapter.acceptEveryOrigin || parseOrigins(adapter.serverOrigins).includes(options.origin);
      return { status: accepted ? 200 : 403, body: accepted ? adapter.metadata : null };
    },
    run(executable, args) {
      calls.push([executable, [...args]]);
      if (executable === '/bin/launchctl') {
        assert.equal(args[1], 'OLLAMA_ORIGINS');
        if (args[0] === 'setenv') adapter.origins = args[2];
        else if (args[0] === 'unsetenv') adapter.origins = null;
        else assert.fail('unexpected launchctl command');
      } else {
        assert.equal(executable, '/usr/bin/open');
        assert.equal(args[0], '--env');
        assert.equal(args[2], '-a');
        assert.equal(args[3], '/Applications/Ollama.app');
        assert.equal(args.length, 4);
        assert.ok(args[1].startsWith('OLLAMA_ORIGINS='));
        if (adapter.failOpen) throw new Error('synthetic open failure');
        // Server inheritance is distinct from the login-session environment.
        adapter.serverStarted = true;
        adapter.serverOrigins = args[1].slice('OLLAMA_ORIGINS='.length);
      }
    },
  };
  return adapter;
}

const manual = { mode: 'manual', confirmOriginSetup: true, confirmOllamaStopped: true };
const hook = { ...manual, mode: 'login-hook', confirmLoginItemDisabled: true };

test('union retains existing finite origins, order, duplicate/trailing entries and exact extension identity', async () => {
  assert.equal(mergeOrigins(' http://localhost:8080,https://example.invalid, http://localhost:8080, ,'), `http://localhost:8080,https://example.invalid,${EXTENSION_ORIGIN}`);
  assert.equal(mergeOrigins(`${EXTENSION_ORIGIN},${EXTENSION_ORIGIN},`), EXTENSION_ORIGIN);
  assert.equal(mergeOrigins(`${EXTENSION_ORIGIN}/`), `${EXTENSION_ORIGIN}/,${EXTENSION_ORIGIN}`);
  assert.deepEqual(parseOrigins('http://[::1]:8080,https://example.invalid/'), ['http://[::1]:8080', 'https://example.invalid/']);
  assert.equal(mergeOrigins(null), EXTENSION_ORIGIN);
});

test('wildcard and non-origin inputs fail without revealing credentials or supplied values', async () => {
  for (const value of ['*', 'http://localhost:*', 'https://*.invalid', 'https://user:synthetic-secret@example.invalid', 'https://example.invalid/path', 'https://example.invalid?secret=value', "https://example.invalid';$(do-not-run)", 'http://localhost\nSECRET']) {
    assert.throws(() => mergeOrigins(value), error => !error.message.includes('synthetic-secret') && !error.message.includes('$(do-not-run)') && !error.message.includes('SECRET'));
  }
});

test('plist escapes literal paths and runs exactly one existing helper without KeepAlive', async () => {
  const plist = launchAgentPlist('/synthetic/Node & "runtime"/node', "/synthetic/<Owner's>/setup.mjs");
  assert.ok(plist.includes('Node &amp; &quot;runtime&quot;'));
  assert.ok(plist.includes('&lt;Owner&apos;s&gt;'));
  assert.ok(plist.includes('<key>RunAtLoad</key><true/>'));
  assert.ok(plist.includes('<key>KeepAlive</key><false/>'));
  assert.ok(plist.includes('<string>--run-login-hook</string>'));
  assert.ok(!plist.includes('ollama serve') && !plist.includes('StartInterval') && !plist.includes('Sockets'));
});

test('default preparation writes only review artifacts under cwd and invokes no native commands', async () => {
  const adapter = memoryAdapter('https://existing.invalid');
  let created = 0;
  const result = await main([], () => { created++; return adapter; });
  assert.equal(created, 1);
  assert.equal(result.action, 'prepared');
  for (const file of adapter.files.keys()) assert.ok(file.startsWith(`${adapter.cwd}/.macos-ollama-setup-review/`));
  assert.equal(adapter.origins, 'https://existing.invalid');
  assert.ok(!adapter.calls.some(call => call[0].startsWith('/bin/') || call[0] === '/usr/bin/open'));
  assert.throws(() => prepareSetup(adapter), /conflict/);
});

test('login-hook preview describes verified competing service disable through UI or the narrow override', () => {
  const adapter = memoryAdapter();
  const result = prepareSetup(adapter, { mode: 'login-hook' });
  const preview = JSON.parse(adapter.files.get(path.join(result.directory, 'preview.json')));
  const requirement = preview.prerequisites.find(value => value.includes('com.ollama.ollama'));
  assert.match(requirement, /official UI or the narrow operator override/);
  assert.match(requirement, /verify it is disabled before installation and remains disabled/);
  assert.match(preview.behavior, /does not register the LaunchAgent/);
  assert.match(preview.uninstall, /never edited or automatically restored/);
});

test('installation requires each explicit prerequisite before any mutation', async () => {
  for (const options of [{}, { ...manual, confirmOriginSetup: false }, { ...manual, confirmOllamaStopped: false }, { ...hook, confirmLoginItemDisabled: false }]) {
    const adapter = memoryAdapter();
    await assert.rejects(installSetup(adapter, options));
    assert.equal(adapter.calls.length, 0);
  }
  const adapter = memoryAdapter();
  adapter.platform = 'linux';
  await assert.rejects(installSetup(adapter, manual), /macOS-only/);
  assert.equal(adapter.calls.length, 0);
});

test('manual install uses exec argv, preserves originals and owns no unrelated startup setting', async () => {
  const original = 'http://localhost:8080, https://existing.invalid,';
  const adapter = memoryAdapter(original);
  await installSetup(adapter, manual);
  assert.equal(adapter.origins, `http://localhost:8080,https://existing.invalid,${EXTENSION_ORIGIN}`);
  assert.ok(!adapter.files.has(setupPaths(adapter.home).plist));
  const nativeCalls = adapter.calls.filter(call => call[0].startsWith('/'));
  assert.deepEqual(nativeCalls, [
    ['/bin/launchctl', ['setenv', 'OLLAMA_ORIGINS', adapter.origins]],
    ['/usr/bin/open', ['--env', `OLLAMA_ORIGINS=${adapter.origins}`, '-a', '/Applications/Ollama.app']],
  ]);
  const state = JSON.parse(adapter.files.get(setupPaths(adapter.home).state));
  assert.equal(state.restoreValue, original);
  assert.equal(state.addedOrigin, true);
  assert.deepEqual(state.previousFiles, { script: 'absent', state: 'absent', plist: 'absent' });
  uninstallSetup(adapter, { confirmRemoveSetup: true });
  assert.equal(adapter.origins, original);
  assert.equal(adapter.files.size, 0);
});

test('existing exact origin is preserved literally and not removed during uninstall', async () => {
  const original = ` https://existing.invalid,${EXTENSION_ORIGIN}, `;
  const adapter = memoryAdapter(original);
  await installSetup(adapter, manual);
  assert.equal(adapter.origins, original);
  assert.equal(JSON.parse(adapter.files.get(setupPaths(adapter.home).state)).addedOrigin, false);
  uninstallSetup(adapter, { confirmRemoveSetup: true });
  assert.equal(adapter.origins, original);
});

test('login hook persists the finite union across a fresh login and retains later custom additions', async () => {
  const adapter = memoryAdapter('http://localhost:8080');
  const installed = await installSetup(adapter, hook);
  assert.match(installed.note, /register the LaunchAgent separately/);
  assert.ok(!adapter.calls.some(call => call[0] === '/bin/launchctl' && call[1][0] === 'bootstrap'));
  const paths = setupPaths(adapter.home);
  assert.ok(adapter.files.get(paths.plist).includes(LABEL));
  adapter.origins = null; // A new login session does not retain launchctl setenv.
  adapter.serverStarted = false;
  await launchSetup(adapter, { loginHook: true });
  assert.equal(adapter.origins, `http://localhost:8080,${EXTENSION_ORIGIN}`);
  adapter.origins = `https://later.invalid,${EXTENSION_ORIGIN}`;
  adapter.serverStarted = false;
  await launchSetup(adapter, { loginHook: true });
  assert.equal(adapter.origins, `http://localhost:8080,https://later.invalid,${EXTENSION_ORIGIN}`);
  uninstallSetup(adapter, { confirmRemoveSetup: true });
  assert.equal(adapter.origins, 'http://localhost:8080,https://later.invalid');
  assert.equal(adapter.files.size, 0);
});

test('colliding files, changed ownership and later environment edits are preserved', async () => {
  for (const target of ['state', 'script', 'plist', 'lock']) {
    const adapter = memoryAdapter();
    adapter.files.set(setupPaths(adapter.home)[target], 'synthetic other owner');
    await assert.rejects(installSetup(adapter, manual), /occupied/);
    assert.equal(adapter.files.get(setupPaths(adapter.home)[target]), 'synthetic other owner');
    assert.equal(adapter.calls.length, 0);
  }
  for (const target of ['script', 'plist']) {
    const adapter = memoryAdapter();
    await installSetup(adapter, hook);
    adapter.files.set(setupPaths(adapter.home)[target], 'synthetic later edit');
    const origins = adapter.origins;
    assert.throws(() => uninstallSetup(adapter, { confirmRemoveSetup: true }), /changed/);
    assert.equal(adapter.origins, origins);
    assert.equal(adapter.files.get(setupPaths(adapter.home)[target]), 'synthetic later edit');
  }
  const adapter = memoryAdapter();
  await installSetup(adapter, manual);
  adapter.origins = 'https://later.invalid';
  assert.throws(() => uninstallSetup(adapter, { confirmRemoveSetup: true }), /outside this helper/);
  assert.equal(adapter.origins, 'https://later.invalid');
  assert.ok(adapter.files.has(setupPaths(adapter.home).state));
});

test('failed app open preserves environment and owned evidence because the app may have started', async () => {
  const adapter = memoryAdapter('https://existing.invalid');
  adapter.failOpen = true;
  await assert.rejects(installSetup(adapter, hook), /startup was attempted/);
  assert.equal(adapter.origins, `https://existing.invalid,${EXTENSION_ORIGIN}`);
  assert.equal(adapter.files.size, 3);
  assert.ok(!adapter.files.has(setupPaths(adapter.home).lock));
  assert.ok(!adapter.calls.some(call => ['kill', 'killall', 'pkill', 'bootout', 'bootstrap'].includes(call[1]?.[0])));
});

test('rollback preserves external origin drift and the ownership evidence', async () => {
  const adapter = memoryAdapter('https://existing.invalid');
  const run = adapter.run;
  adapter.run = (executable, args) => {
    if (executable === '/usr/bin/open') {
      adapter.origins = 'https://concurrent-client.invalid';
      throw new Error('synthetic launch interruption');
    }
    return run(executable, args);
  };
  await assert.rejects(installSetup(adapter, manual), /preserved for operator review/);
  assert.equal(adapter.origins, 'https://concurrent-client.invalid');
  assert.ok(adapter.files.has(setupPaths(adapter.home).state));
  assert.ok(adapter.files.has(setupPaths(adapter.home).script));
  assert.ok(!adapter.files.has(setupPaths(adapter.home).lock));
});

test('uninstall never deletes a file edited after ownership validation', async () => {
  const adapter = memoryAdapter();
  await installSetup(adapter, hook);
  const paths = setupPaths(adapter.home);
  const run = adapter.run;
  adapter.run = (executable, args) => {
    run(executable, args);
    if (executable === '/bin/launchctl') adapter.files.set(paths.plist, 'synthetic concurrent owner edit');
  };
  assert.throws(() => uninstallSetup(adapter, { confirmRemoveSetup: true }), /removal was interrupted/);
  assert.equal(adapter.files.get(paths.plist), 'synthetic concurrent owner edit');
  assert.ok(adapter.files.has(paths.state));
  assert.ok(adapter.files.has(paths.script));
});

test('failed open during later launch retains current ownership and origin provenance', async () => {
  const adapter = memoryAdapter('https://existing.invalid');
  await installSetup(adapter, manual);
  const stateBefore = adapter.files.get(setupPaths(adapter.home).state);
  adapter.origins = 'https://later.invalid';
  adapter.serverStarted = false;
  adapter.failOpen = true;
  await assert.rejects(launchSetup(adapter, { confirmOllamaStopped: true }), /startup was attempted/);
  assert.equal(adapter.origins, `https://existing.invalid,https://later.invalid,${EXTENSION_ORIGIN}`);
  assert.notEqual(adapter.files.get(setupPaths(adapter.home).state), stateBefore);
  assert.equal(JSON.parse(adapter.files.get(setupPaths(adapter.home).state)).restoreValue, 'https://existing.invalid,https://later.invalid');
});

test('unsafe state and wildcard login changes fail before environment/app mutation', async () => {
  const adapter = memoryAdapter();
  await installSetup(adapter, hook);
  adapter.origins = '*';
  const calls = adapter.calls.length;
  await assert.rejects(launchSetup(adapter, { loginHook: true }), /Wildcard/);
  assert.ok(adapter.calls.slice(calls).every(call => ['write', 'remove'].includes(call[0])));
  assert.equal(adapter.origins, '*');
  await assert.rejects(launchSetup(memoryAdapter(), { loginHook: true }), /No owned/);
  adapter.origins = EXTENSION_ORIGIN;
  const state = JSON.parse(adapter.files.get(setupPaths(adapter.home).state));
  delete state.restoreValue;
  adapter.files.set(setupPaths(adapter.home).state, JSON.stringify(state));
  assert.throws(() => uninstallSetup(adapter, { confirmRemoveSetup: true }), /Unknown ownership/);
  assert.equal(adapter.origins, EXTENSION_ORIGIN);
});

test('CLI accepts concrete operator actions without implicit mutation or origin override', async () => {
  assert.equal(parseArguments([]).command, '--prepare');
  assert.deepEqual(parseArguments(['--install', '--mode', 'manual', '--confirm-origin-setup', '--confirm-ollama-stopped']), { command: '--install', mode: 'manual', confirmOriginSetup: true, confirmOllamaStopped: true });
  assert.throws(() => parseArguments(['--install', '--origins', 'https://override.invalid']), /review-only/);
  assert.throws(() => parseArguments(['--launch', '--uninstall']), /exactly one/);
  assert.throws(() => parseArguments(['--not-supported=synthetic-secret']), error => !error.message.includes('synthetic-secret'));
  assert.equal(path.basename(setupPaths('/synthetic').script), 'macos-ollama-setup.mjs');
  assert.deepEqual(parseArguments(['--upgrade']), { command: '--upgrade' });
});

test('CLI help describes every operator action and never constructs or accesses a native adapter', () => {
  let created = 0;
  const forbiddenFactory = () => { created++; throw new Error('native adapter was constructed'); };
  const forbiddenAdapter = new Proxy({}, { get() { throw new Error('native adapter was accessed'); } });
  for (const argument of ['--help', '-h']) {
    assert.equal(main([argument], forbiddenFactory), HELP_TEXT);
    assert.equal(main([argument], forbiddenAdapter), HELP_TEXT);
  }
  assert.equal(created, 0);
  for (const option of ['--prepare', '--install', '--mode manual', '--mode login-hook', '--launch', '--upgrade', '--uninstall', '--run-login-hook', '--confirm-origin-setup', '--confirm-ollama-stopped', '--confirm-login-item-disabled', '--confirm-remove-setup']) assert.ok(HELP_TEXT.includes(option));
  assert.match(HELP_TEXT, /com\.ollama\.ollama/);
  assert.match(HELP_TEXT, /disabled and verified through the official UI or the narrow/);
  assert.match(HELP_TEXT, /register the LaunchAgent\s+separately/);
  assert.match(HELP_TEXT, /Remove owned job registration separately/);
});

test('CLI rejects unknown, malformed, conflicting and unsupported options before native adapter creation', () => {
  let created = 0;
  const forbiddenFactory = () => { created++; throw new Error('native adapter was constructed'); };
  for (const args of [
    ['--not-supported=synthetic-secret'], ['--help', '--synthetic-secret'],
    ['--prepare', '--launch'], ['--mode'], ['--mode', 'synthetic-secret'],
    ['--mode', 'manual', '--mode', 'login-hook'], ['--origins', '*'],
    ['--upgrade', '--confirm-remove-setup'], ['--launch', '--mode', 'manual', '--confirm-ollama-stopped'],
    ['--install', '--mode', 'login-hook', '--confirm-origin-setup', '--confirm-ollama-stopped'],
    ['--launch'], ['--uninstall'],
  ]) {
    assert.throws(() => main(args, forbiddenFactory), error => !error.message.includes('synthetic-secret') && !error.message.includes('native adapter was constructed'));
  }
  assert.equal(created, 0);
});

test('the predecessor falsely reports startup success when GUI origins are not inherited; explicit launch fixes it', async () => {
  assert.equal(hash(predecessorSource), PREDECESSOR_SCRIPT_HASH);
  const importable = predecessorSource.slice(0, predecessorSource.indexOf('\nif (process.argv[1]'));
  const predecessor = await import(`data:text/javascript;base64,${Buffer.from(importable).toString('base64')}`);
  const old = memoryAdapter('https://existing.invalid');
  const run = old.run;
  old.run = (executable, args) => {
    if (executable !== '/usr/bin/open') return run(executable, args);
    assert.deepEqual(args, ['-a', '/Applications/Ollama.app']);
    old.serverStarted = true;
    old.serverOrigins = null; // LaunchServices started without the GUI setting.
  };
  assert.equal(predecessor.installSetup(old, manual).action, 'installed');
  assert.equal((await old.request('/api/show', { body: { model: PINNED_MODEL }, origin: EXTENSION_ORIGIN, timeoutMs: REQUEST_TIMEOUT_MS })).status, 403);
  const current = memoryAdapter('https://existing.invalid');
  assert.equal((await installSetup(current, manual)).action, 'installed');
  assert.equal(current.serverOrigins, `https://existing.invalid,${EXTENSION_ORIGIN}`);
  assert.ok(current.calls.some(call => call[0] === 'metadata' && call[1] === '/api/show' && call[2].origin !== EXTENSION_ORIGIN));
});

test('an already qualified running server returns Ready without opening or restarting it', async () => {
  const adapter = memoryAdapter();
  await installSetup(adapter, hook);
  const calls = adapter.calls.length;
  const result = await launchSetup(adapter, { loginHook: true });
  assert.equal(result.action, 'ready');
  assert.ok(!adapter.calls.slice(calls).some(call => call[0] === '/usr/bin/open'));
  assert.equal(adapter.calls.slice(calls).filter(call => call[0] === 'metadata').length, 3);
});

test('an existing wrong-Origin server fails immediately before environment or ownership changes', async () => {
  const adapter = memoryAdapter('https://existing.invalid');
  await installSetup(adapter, hook);
  const paths = setupPaths(adapter.home);
  const before = adapter.files.get(paths.state);
  adapter.origins = null;
  adapter.serverOrigins = 'https://existing.invalid';
  const calls = adapter.calls.length;
  await assert.rejects(launchSetup(adapter, { loginHook: true }), /competing Ollama login\/background startup/);
  assert.equal(adapter.origins, null);
  assert.equal(adapter.files.get(paths.state), before);
  assert.ok(adapter.calls.slice(calls).every(call => ['metadata', 'write', 'remove'].includes(call[0])));
  assert.equal(adapter.calls.slice(calls).filter(call => call[0] === 'metadata').length, 2);
  assert.ok(!adapter.calls.slice(calls).some(call => call[0] === 'sleep'));
});

test('incompatible version, pinned model metadata, and broad CORS never trigger retries or app open', async () => {
  for (const failure of ['version', 'metadata', 'origins']) {
    const adapter = memoryAdapter(EXTENSION_ORIGIN);
    adapter.serverStarted = true;
    adapter.serverOrigins = EXTENSION_ORIGIN;
    if (failure === 'version') adapter.version = 'synthetic-wrong-version';
    if (failure === 'metadata') adapter.metadata = { ...pinnedMetadata(), template: 'synthetic-wrong-template' };
    if (failure === 'origins') adapter.acceptEveryOrigin = true;
    await assert.rejects(installSetup(adapter, manual), /not qualified|metadata is incompatible|outside the finite union/);
    assert.equal(adapter.files.size, 0);
    assert.ok(adapter.calls.every(call => call[0] === 'metadata'));
  }
});

test('fresh startup retries only transient connections and waits for final metadata before releasing the lock', async () => {
  const adapter = memoryAdapter();
  adapter.transientFailures = 3;
  const request = adapter.request;
  adapter.request = async (apiPath, options) => {
    if (adapter.serverStarted) assert.ok(adapter.files.has(setupPaths(adapter.home).lock));
    return request(apiPath, options);
  };
  await installSetup(adapter, hook);
  assert.equal(adapter.calls.filter(call => call[0] === 'sleep').length, 3);
  assert.equal(adapter.clock, 750);
  assert.ok(!adapter.files.has(setupPaths(adapter.home).lock));
});

test('fresh startup timeout and post-open Origin rejection preserve applied settings and owned evidence', async () => {
  for (const failure of ['timeout', 'origin']) {
    const adapter = memoryAdapter('https://existing.invalid');
    if (failure === 'timeout') adapter.transientFailures = Infinity;
    else {
      const run = adapter.run;
      adapter.run = (executable, args) => { run(executable, args); if (executable === '/usr/bin/open') adapter.serverOrigins = 'https://existing.invalid'; };
    }
    await assert.rejects(installSetup(adapter, hook), /startup was attempted/);
    assert.equal(adapter.origins, `https://existing.invalid,${EXTENSION_ORIGIN}`);
    assert.equal(adapter.files.size, 3);
    assert.ok(!adapter.files.has(setupPaths(adapter.home).lock));
    assert.ok(adapter.clock <= STARTUP_DEADLINE_MS);
    assert.ok(adapter.calls.every(call => !call[0].startsWith('/') || ['/bin/launchctl', '/usr/bin/open'].includes(call[0])));
    if (failure === 'origin') assert.ok(!adapter.calls.some(call => call[0] === 'sleep'));
  }
});

test('the negative Origin probe is outside the actual finite union even when its first candidate is preserved', async () => {
  const adapter = memoryAdapter('https://bouncer-startup-denied-0.invalid');
  await installSetup(adapter, manual);
  const origins = adapter.calls.filter(call => call[0] === 'metadata' && call[1] === '/api/show').map(call => call[2].origin);
  assert.deepEqual(origins, [EXTENSION_ORIGIN, 'https://bouncer-startup-denied-1.invalid']);
});

test('launcher fixed version and artifact constants stay consistent with the extension contract', () => {
  const models = readFileSync(new URL('../Bouncer/src/shared/models.ts', import.meta.url), 'utf8');
  assert.ok(models.includes(`'${QUALIFIED_OLLAMA_VERSION}'`));
  assert.ok(models.includes(`'${PINNED_MODEL.slice('sha256:'.length)}'`));
  assert.ok(models.includes(`'${PINNED_WEIGHT}'`));
});

test('native metadata transport uses fixed loopback, exact pinned POST, omitted credentials and no redirects', async () => {
  const calls = [];
  const fetch = async (url, options) => { calls.push([url, options]); return Response.json(pinnedMetadata()); };
  await nativeMetadataRequest('/api/show', { body: { model: PINNED_MODEL }, origin: EXTENSION_ORIGIN, timeoutMs: 50 }, fetch);
  assert.equal(calls[0][0], 'http://127.0.0.1:11434/api/show');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].credentials, 'omit');
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(calls[0][1].headers.Origin, EXTENSION_ORIGIN);
  assert.deepEqual(JSON.parse(calls[0][1].body), { model: PINNED_MODEL });
  await assert.rejects(nativeMetadataRequest('/api/generate', { timeoutMs: 50 }, fetch), /Invalid fixed/);
  await assert.rejects(nativeMetadataRequest('/api/show', { body: { model: 'synthetic-secret' }, origin: EXTENSION_ORIGIN, timeoutMs: 50 }, fetch), error => !error.message.includes('synthetic-secret'));
  assert.equal(calls.length, 1);
});

test('native metadata transport bounds response bytes and time and sanitizes failure bodies', async () => {
  const options = { timeoutMs: 5 };
  await assert.rejects(nativeMetadataRequest('/api/version', options, async () => new Promise(() => {})), /bounded timeout/);
  await assert.rejects(nativeMetadataRequest('/api/version', options, async () => new Response('synthetic-secret')), error => /invalid metadata JSON/.test(error.message) && !error.message.includes('synthetic-secret'));
  await assert.rejects(nativeMetadataRequest('/api/version', options, async () => new Response(' '.repeat(256 * 1024 + 1))), /bounded response size/);
  await assert.rejects(nativeMetadataRequest('/api/version', options, async () => { throw new Error('synthetic-secret'); }), error => !error.message.includes('synthetic-secret'));
  const denied = await nativeMetadataRequest('/api/version', options, async () => new Response('synthetic-secret', { status: 403 }));
  assert.deepEqual(denied, { status: 403, body: null });
  await assert.rejects(nativeMetadataRequest('/api/version', options, async () => { throw new TypeError('synthetic-secret', { cause: { code: 'ECONNREFUSED' } }); }), StartupConnectionError);
});

async function predecessorInstallation(mode = 'login-hook', predecessor = predecessorSource) {
  const adapter = memoryAdapter('https://existing.invalid');
  await installSetup(adapter, mode === 'login-hook' ? hook : manual);
  const paths = setupPaths(adapter.home);
  const state = JSON.parse(adapter.files.get(paths.state));
  adapter.files.set(paths.script, predecessor);
  adapter.files.set(paths.state, `${JSON.stringify({ ...state, scriptHash: hash(predecessor) }, null, 2)}\n`);
  return adapter;
}

test('upgrade replaces only known owned predecessor bytes and scriptHash, retaining installation and original Node/plist', async () => {
  const adapter = await predecessorInstallation();
  const paths = setupPaths(adapter.home);
  const before = JSON.parse(adapter.files.get(paths.state));
  const plist = adapter.files.get(paths.plist);
  const origins = adapter.origins;
  adapter.nodePath = '/synthetic/new-runtime/node';
  const calls = adapter.calls.length;
  assert.equal(main(['--upgrade'], adapter).action, 'upgraded');
  const after = JSON.parse(adapter.files.get(paths.state));
  assert.deepEqual(after, { ...before, scriptHash: hash(sourceText) });
  assert.equal(adapter.files.get(paths.script), sourceText);
  assert.equal(adapter.files.get(paths.plist), plist);
  assert.equal(adapter.origins, origins);
  assert.ok(adapter.calls.slice(calls).every(call => ['write', 'remove'].includes(call[0])));
  assert.equal(upgradeSetup(adapter).action, 'up-to-date');
  uninstallSetup(adapter, { confirmRemoveSetup: true });
  assert.equal(adapter.origins, 'https://existing.invalid');
  assert.equal(adapter.files.size, 0);
});

test('upgrade accepts the exact reviewed startup-correction predecessor in manual and login-hook modes', async () => {
  assert.equal(hash(correctedPredecessorSource), CORRECTED_PREDECESSOR_SCRIPT_HASH);
  assert.notEqual(hash(sourceText), CORRECTED_PREDECESSOR_SCRIPT_HASH);
  for (const mode of ['manual', 'login-hook']) {
    const adapter = await predecessorInstallation(mode, correctedPredecessorSource);
    const paths = setupPaths(adapter.home);
    const before = JSON.parse(adapter.files.get(paths.state));
    const plist = adapter.files.get(paths.plist);
    const origins = adapter.origins;
    const calls = adapter.calls.length;
    assert.equal(upgradeSetup(adapter).action, 'upgraded');
    assert.deepEqual(JSON.parse(adapter.files.get(paths.state)), { ...before, scriptHash: hash(sourceText) });
    assert.equal(adapter.files.get(paths.script), sourceText);
    assert.equal(adapter.files.get(paths.plist), plist);
    assert.equal(adapter.origins, origins);
    assert.ok(adapter.calls.slice(calls).every(call => ['write', 'remove'].includes(call[0])));
    assert.equal(upgradeSetup(adapter).action, 'up-to-date');
    uninstallSetup(adapter, { confirmRemoveSetup: true });
    assert.equal(adapter.origins, 'https://existing.invalid');
    assert.equal(adapter.files.size, 0);
  }
});

test('upgrade rejects absent or foreign ownership, unknown owned versions, changed/colliding plist, and invalid Node paths', async () => {
  assert.throws(() => upgradeSetup(memoryAdapter()), /No owned/);
  for (const failure of ['owner', 'script', 'hash', 'trusted-hash', 'plist', 'node', 'manual-plist']) {
    const adapter = await predecessorInstallation(failure === 'manual-plist' ? 'manual' : 'login-hook');
    const paths = setupPaths(adapter.home);
    const state = JSON.parse(adapter.files.get(paths.state));
    if (failure === 'owner') state.owner = 'synthetic-foreign-owner';
    if (failure === 'script') adapter.files.set(paths.script, 'synthetic concurrent script');
    if (failure === 'hash') { adapter.files.set(paths.script, 'synthetic unknown owned version'); state.scriptHash = hash(adapter.files.get(paths.script)); }
    if (failure === 'trusted-hash') { adapter.files.set(paths.script, 'synthetic unknown owned version'); state.scriptHash = CORRECTED_PREDECESSOR_SCRIPT_HASH; }
    if (failure === 'plist') { adapter.files.set(paths.plist, 'synthetic unknown plist'); state.plistHash = hash(adapter.files.get(paths.plist)); }
    if (failure === 'node') state.nodeExecutable = 'relative-node';
    if (failure === 'manual-plist') adapter.files.set(paths.plist, 'synthetic foreign plist');
    adapter.files.set(paths.state, JSON.stringify(state));
    const before = new Map(adapter.files);
    assert.throws(() => upgradeSetup(adapter), /ownership|changed|recognized|Unexpected/);
    assert.deepEqual(adapter.files, before);
  }
});

test('failed upgrade ownership write restores only known launcher bytes and preserves original state', async () => {
  const adapter = await predecessorInstallation();
  const paths = setupPaths(adapter.home);
  const before = new Map(adapter.files);
  const write = adapter.write;
  adapter.write = (file, content, options) => { if (file === paths.state) throw new Error('synthetic write failure'); return write(file, content, options); };
  assert.throws(() => upgradeSetup(adapter), /known predecessor was restored/);
  assert.deepEqual(adapter.files, before);
});

test('failed upgrade preserves concurrent script/state edits and fails closed after a simulated crash between writes', async () => {
  for (const target of ['script', 'state']) {
    const adapter = await predecessorInstallation();
    const paths = setupPaths(adapter.home);
    const write = adapter.write;
    adapter.write = (file, content, options) => {
      if (file === paths.state) { adapter.files.set(paths[target], 'synthetic concurrent edit'); throw new Error('synthetic write failure'); }
      return write(file, content, options);
    };
    assert.throws(() => upgradeSetup(adapter), /concurrent edits were preserved/);
    assert.equal(adapter.files.get(paths[target]), 'synthetic concurrent edit');
    assert.ok(!adapter.files.has(paths.lock));
  }
  const adapter = await predecessorInstallation();
  const paths = setupPaths(adapter.home);
  adapter.files.set(paths.script, sourceText); // Crash before ownership replacement.
  assert.throws(() => upgradeSetup(adapter), /launcher changed/);
  await assert.rejects(launchSetup(adapter, { loginHook: true }), /launcher changed/);
  assert.equal(adapter.files.get(paths.script), sourceText);
});
